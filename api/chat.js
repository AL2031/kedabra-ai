import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lsFiles, readFile, writeFile, shell, getWorkspaceSnapshot } from './_lib.js';
import { isProgressOnly, readToolCacheKey, findCachedRead, rememberRead, toolMutatesWorkspace } from './agent-guards.js';
import { analyzeImages, validateImages } from './vision.js';
import { requireUser } from './_auth.js';
import { LEASE_MS, runtime, startCancelWatcher, validContinueToken, shouldContinueInBackground, scheduleContinuation } from './_background.js';
import { getJobRow, createJobRow, saveJobData, claimJob, releaseJob, requestJobCancel, isJobCancelRequested, LeaseLostError } from './_store.js';
import { mergeProviderToolCall, hasGoogleThoughtSignature, messagesForProvider, isRetryableProviderStatus } from './gemini-compat.js';

const DAY = new Date().toDateString();
const SYS = `You are Kedabra, an expert AI engineer and assistant at kedabra.ai, running in a persistent cloud workspace.
Tools: web_search, fetch_url, run_python, run_javascript, create_file, write_files, read_file, edit_file, list_files, terminal, present_file, spawn_subagents.
Execution discipline: inspect the workspace once, then inspect only files relevant to the assigned task. Never read the same file or list the workspace repeatedly unless the file changed. A repeated read of the same path returns a cached result. Do not issue speculative or unrelated commands. Prefer one focused batch of file reads, then implement the task, then run focused tests and verify changed files. Do not narrate what you plan to do; actually do it. A progress announcement is not a deliverable. Preserve existing features unless asked to remove them. Never claim a test ran unless it did. Be concise and use markdown. For web research, use as many distinct searches and source pages as the task genuinely requires; there is no fixed search or page-count ceiling. Prioritize primary/authoritative sources, avoid duplicate domains, cache repeated reads, and stop when evidence is sufficient. Cite researched claims with markdown links to the source URLs and include publication dates when available. Return the actual findings, not a plan to search. Today is ${DAY}.`;
const PLANNER_SYS = `You are Kedabra's task planner and model router. Convert the user's request into an executable plan. Return ONLY valid JSON, no markdown.
Schema: {"objective":"...","reason":"...","steps":[{"id":"s1","title":"short label","task":"detailed self-contained instructions and success criteria","model":"reasoning|coding|gemini"}]}
Use one step for a simple direct answer and choose as many steps as the task genuinely requires. There is no fixed maximum number of steps, agent rounds, or tool operations. Do not split inspection, implementation and verification into separate steps when one focused step can do them. Avoid steps that cause later models to re-inspect files already inspected. Make steps sequential only when later steps depend on earlier output. Prefer parallel subtasks only when truly independent and use spawn_subagents inside a step when useful. Select the lowest-cost model that can do each step reliably: reasoning for planning, explanation, synthesis and general tasks; coding for code creation, debugging, refactoring and tests; gemini only when a distinct model is a good fit and is listed as available. Model IDs must exactly match the available catalog. Do not invent models or use a model that is not listed. Keep each step concrete and independently actionable. Do not create unnecessary steps.`;
const SUMMARY_SYS = `You are Kedabra's execution-context summarizer. Update the running project memory using the previous summary and the latest completed step. Return ONLY the updated summary as plain text. Preserve all still-relevant user requirements, decisions, constraints, files created/changed and their roles, interfaces, tests and outcomes, unresolved issues, and the exact next action. Remove stale detail and repetition. Do not claim success unless the step result or tool output confirms it. Keep the result compact (aim for 1,500-3,000 characters; never exceed 5,000). This summary will be the ONLY prior-task context shown to the next execution step.`;
const SUBSYS = `You are a focused Kedabra sub-agent. Do ONLY your assigned task using the tools, write requested files to exact paths, and reply with a short summary of changes, file paths, tests, and anything the lead must know.`;

const groqKeys = [...new Set(
  [1, 2, 3, 4].map(i => process.env['GROQ_API_KEY_' + i])
    .concat((process.env.GROQ_API_KEYS || '').split(','))
    .map(key => key && key.trim()).filter(Boolean)
)];
const GOOGLE_KEY = process.env.GOOGLE_API_KEY?.trim();
const MODELS = {
  reasoning: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  coding: process.env.QWEN_MODEL || 'qwen/qwen3.8-27b',
  gemini: (() => { const configured = process.env.GOOGLE_MODEL?.trim(); return !configured || /^gemini-2\.5-(?:flash|pro)(?:-|$)/.test(configured) ? 'gemini-3.6-flash' : configured; })(),
};
const MODEL_CATALOG = {
  reasoning: { id: 'reasoning', label: 'Thinker', model: MODELS.reasoning, provider: 'groq', purpose: 'deep reasoning, planning, analysis, general work and final synthesis' },
  coding: { id: 'coding', label: 'Coder', model: MODELS.coding, provider: 'groq', purpose: 'software engineering, code creation, debugging, refactoring and tests' },
  ...(GOOGLE_KEY ? { gemini: { id: 'gemini', label: 'Genius', model: MODELS.gemini, provider: 'google', purpose: 'fast general intelligence and multimodal tasks' } } : {}),
};
const badUntil = new Map();
let roundRobin = 0;
const INVOCATION_BUDGET_MS = Number(process.env.INVOCATION_BUDGET_MS) || 180_000;
// Large reasoning models need more than 14s to finish a streamed response.
const PROVIDER_TIMEOUT_MS = 35_000;
const MAX_TOOL_OUTPUT = 5_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CODE_RE = /```|\b(code|coding|programs?|programming|script|scripts|function|bug|debug|fix|error|exception|stack ?trace|compile|refactor|implement|algorithm|regex|api|endpoint|sdk|html|css|javascript|typescript|python|java|rust|golang|sql|database|react|vue|svelte|next\.js|node|npm|pip|git|github|repo|deploy|docker|website|web ?site|web ?page|web ?app|game|component|frontend|backend|full[- ]?stack|bot|extension|plugin|framework|terminal|shell|bash|cli|json|yaml|xml|lua|roblox|three\.js|build me)\b|c\+\+|c#|\.(py|js|ts|html|css|json|jsx|tsx)\b/i;

class PauseRun extends Error { constructor(message = 'Checkpoint reached; continuing in the next request.') { super(message); this.name = 'PauseRun'; } }
class CancelRun extends Error { constructor() { super('Stopped by user.'); this.name = 'CancelRun'; } }

function candidates(modelId = 'reasoning') {
  const selected = MODEL_CATALOG[modelId] || MODEL_CATALOG.reasoning;
  const options = [selected, ...Object.values(MODEL_CATALOG).filter(item => item.id !== selected.id)];
  const start = groqKeys.length ? roundRobin++ % groqKeys.length : 0;
  const rotatedKeys = groqKeys.length ? [...groqKeys.slice(start), ...groqKeys.slice(0, start)] : [];
  const list = [];
  for (const option of options) {
    if (option.provider === 'groq') {
      rotatedKeys.forEach((key, index) => {
        const keyIndex = groqKeys.indexOf(key) + 1;
        list.push({ key, model: option.model, url: 'https://api.groq.com/openai/v1/chat/completions', name: `${option.model} · Groq key ${keyIndex}`, modelId: option.id, provider: 'groq' });
      });
    } else if (option.provider === 'google' && GOOGLE_KEY) {
      list.push({ key: GOOGLE_KEY, model: option.model, url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', name: `${option.model} · Google`, modelId: option.id, provider: 'google' });
    }
  }
  const healthy = list.filter(item => !(badUntil.get(item.key + ':' + item.model) > Date.now()));
  return healthy.length ? healthy : list;
}

async function readStream(response, onText) {
  const msg = { content: '', tool_calls: [], finish_reason: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', raw = '', shown = 0, sawDone = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { sawDone = true; continue; }
      let data; try { data = JSON.parse(payload); } catch { continue; }
      const choice = data.choices?.[0];
      if (choice?.finish_reason) msg.finish_reason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      if (delta.content) {
        raw += delta.content;
        const visible = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').replace(/<(t(h(i(n(k)?)?)?)?)?$/, '');
        if (visible.length > shown) { onText?.(visible.slice(shown)); shown = visible.length; }
      }
      for (const tool of delta.tool_calls || []) {
        const index = tool.index ?? 0;
        const call = (msg.tool_calls[index] ??= { id: tool.id || `call_${index}_${Date.now()}`, type: 'function', function: { name: '', arguments: '' } });
        if (tool.id) call.id = tool.id;
        if (tool.type) call.type = tool.type;
        if (tool.function?.name) call.function.name += tool.function.name;
        if (tool.function?.arguments) call.function.arguments += tool.function.arguments;
        // Gemini 3 returns its required thought signature as provider-specific
        // metadata on the OpenAI-compatible tool_call. Preserve it verbatim.
        mergeProviderToolCall(call, tool);
      }
      // Be tolerant of adapters that stream the Google metadata beside the
      // tool_calls array instead of on the individual tool-call delta.
      if (msg.tool_calls.length && delta.extra_content?.google?.thought_signature) {
        mergeProviderToolCall(msg.tool_calls[0], { extra_content: delta.extra_content });
      }
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  msg.content = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
  if (!sawDone && !msg.content && !msg.tool_calls.length) throw new Error('Provider closed the stream without a response.');
  if (!sawDone) throw new Error('Provider stream ended before completion; retrying the request.');
  return msg;
}

async function llm(messages, tools, modelId, { deadline, send, dead, onText, maxTokens } = {}) {
  let cycle = 0, backoff = 1_500, lastError = 'No API keys are configured.';
  for (;;) {
    if (dead?.()) throw new CancelRun();
    if (Date.now() >= deadline) throw new PauseRun();
    const available = candidates(modelId);
    if (!available.length) {
      lastError = 'No usable API keys are configured. Add a Groq or Google key in Vercel environment variables.';
    } else {
      let permanentError = null;
      let retryableErrorSeen = false;
      for (const provider of available) {
        if (dead?.()) throw new CancelRun();
        if (Date.now() >= deadline) throw new PauseRun();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
        try {
          const baseTokens = maxTokens || (tools?.length ? (provider.modelId === 'coding' ? 4_000 : 2_400) : 1_400);
          const body = {
            model: provider.model,
            messages: messagesForProvider(messages, provider.provider),
            temperature: provider.modelId === 'coding' ? 0.2 : 0.45,
            // If the provider reports a length stop, the next attempt gets a
            // larger output allowance instead of silently accepting a fragment.
            max_tokens: Math.min(12_000, Math.round(baseTokens * Math.pow(1.6, Math.min(cycle, 3)))),
            stream: true,
            ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
          };
          const response = await fetch(provider.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.key },
            body: JSON.stringify(body), signal: controller.signal,
          });
          if (!response.ok) {
            const errorText = await response.text();
            const status = response.status;
            const error = new Error(`${provider.name} (${status}): ${errorText.slice(0, 500)}`);
            error.status = status;
            error.retryable = isRetryableProviderStatus(status);
            if (!error.retryable) badUntil.set(provider.key + ':' + provider.model, Date.now() + 10 * 60_000);
            else if (status === 429) badUntil.set(provider.key + ':' + provider.model, Date.now() + 60_000);
            else if (status >= 500) badUntil.set(provider.key + ':' + provider.model, Date.now() + 30_000);
            throw error;
          }
          const msg = await readStream(response, text => onText?.(text));
          if (provider.provider === 'google' && /^gemini-3(?:\.|-)/i.test(provider.model) && msg.tool_calls.length && !hasGoogleThoughtSignature(msg.tool_calls[0])) {
            const error = new Error(`${provider.name} returned a function call without extra_content.google.thought_signature. The tool call was not executed; update/redeploy Kedabra's Gemini compatibility fix or check the provider response format.`);
            error.retryable = false;
            throw error;
          }
          if (msg.finish_reason === 'length') {
            const error = new Error(`${provider.name} stopped at the output-token limit; retrying with a larger allowance.`);
            error.truncated = true;
            throw error;
          }
          if (!msg.content && !msg.tool_calls.length) throw new Error(`${provider.name} returned an empty response.`);
          if (cycle > 0) send?.({ t: 'retry_clear' });
          return { msg, via: provider.name, modelId: provider.modelId };
        } catch (error) {
          lastError = error?.name === 'AbortError' ? `${provider.name} timed out after ${PROVIDER_TIMEOUT_MS / 1000}s.` : String(error?.message || error);
          if (error?.retryable === false) {
            permanentError = error;
            badUntil.set(provider.key + ':' + provider.model, Date.now() + 10 * 60_000);
          } else {
            retryableErrorSeen = true;
          }
          if (onText) send?.({ t: 'reset_delta' });
        } finally { clearTimeout(timeout); }
      }
      // A malformed request (especially Gemini's missing-signature 400) cannot
      // be repaired by sending the identical payload again. Stop the retry
      // loop once every available provider has returned a permanent error.
      if (permanentError && !retryableErrorSeen) throw permanentError;
    }
    cycle++;
    const wait = Math.min(backoff, 15_000);
    send?.({ t: 'retry', attempt: cycle, model: modelId, waitMs: wait, detail: lastError, keyCount: groqKeys.length + (GOOGLE_KEY ? 1 : 0) });
    await sleep(Math.min(wait, Math.max(100, deadline - Date.now())));
    backoff = Math.min(Math.round(backoff * 1.7), 15_000);
  }
}

function parseJsonObject(text) {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf('{'), last = clean.lastIndexOf('}');
  if (first >= 0 && last > first) { try { return JSON.parse(clean.slice(first, last + 1)); } catch {} }
  return null;
}

function fallbackPlan(task) {
  const code = CODE_RE.test(task);
  return {
    objective: task,
    reason: 'A safe one-step fallback plan was used because the planner response was not valid JSON.',
    steps: [{ id: 's1', title: code ? 'Implement and verify' : 'Answer the request', task, model: code ? 'coding' : 'reasoning', modelName: MODEL_CATALOG[code ? 'coding' : 'reasoning'].label }],
  };
}

async function summarizeHistory(job, deadline, send, dead) {
  // Conversation context is already available as text. Deterministic trimming
  // avoids spending a full model call just to summarize a few recent turns.
  const history = (job.history || []).slice(-6).map(message => {
    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    return `${role}: ${String(message.content || '').replace(/\s+/g, ' ').slice(0, 1_000)}`;
  }).join('\n');
  return history.slice(-6_000);
}

function directPlan(task, preferredModelId = 'auto', webSearch = false) {
  if (CODE_RE.test(task)) return null;
  const complex = /\b(?:build|create|implement|design|redesign|fix|debug|refactor|update|modify|integrate|automate|multi[- ]step|step[- ]by[- ]step|compare|comprehensive|exhaustive|research report|proposal|business plan|roadmap)\b/i.test(task) || task.length > 650;
  if (complex) return null;
  const model = MODEL_CATALOG[preferredModelId] ? preferredModelId : 'reasoning';
  const webInstruction = webSearch ? '\n\nThe user enabled web search. Use the web_search tool to verify current details and cite the sources in your answer.' : '';
  return {
    objective: task,
    reason: 'A single focused pass is sufficient; planning would add overhead without improving the result.',
    steps: [{ id: 's1', title: 'Answer the request', task: `${task}${webInstruction}\n\nComplete the request directly. For current or niche facts, search as extensively as the task requires and verify useful primary sources. Do not narrate intentions. End with a complete, self-contained answer.`, model, modelName: MODEL_CATALOG[model].label }],
  };
}

async function makePlan(job, deadline, send, dead) {
  const direct = directPlan(job.request, job.selectedModel || 'auto', Boolean(job.webSearch));
  if (direct) return direct;
  const catalog = Object.values(MODEL_CATALOG).map(m => ({ id: m.id, model: m.model, purpose: m.purpose }));
  const preference = MODEL_CATALOG[job.selectedModel] ? `\n\nUSER MODEL SELECTION: The user explicitly chose ${job.selectedModel} (${MODEL_CATALOG[job.selectedModel].model}). Use this model for every execution step; do not switch models unless it is unavailable.` : '';
  const webInstruction = job.webSearch ? '\n\nWEB SEARCH MODE: The user explicitly enabled web search. Use web_search to gather current, relevant sources and cite the source URLs in the final answer.' : '';
  const prompt = `AVAILABLE MODELS:\n${JSON.stringify(catalog)}\n\nMODEL-SUMMARIZED CONVERSATION CONTEXT:\n${job.summary || '(none)'}\n\nVISUAL REFERENCES (already inspected by the multimodal model; treat these as source material):\n${job.visualContext || '(No images attached.)'}\n\nCURRENT USER REQUEST:\n${job.request}${preference}${webInstruction}\n\nCreate the execution plan. Choose an exact model ID for every step. Keep related inspection, implementation and testing in the same step where practical. Include only the files and tools needed. Do not create multiple steps that would reread the same workspace files. If visual references are present, make sure implementation steps explicitly use their relevant details. Do not ask the coding model to infer details that are already established in the visual analysis.`;
  const response = await llm([{ role: 'system', content: PLANNER_SYS }, { role: 'user', content: prompt }], [], 'reasoning', { deadline, send, dead, maxTokens: 12_000 });
  const data = parseJsonObject(response.msg.content);
  const allowed = new Set(Object.keys(MODEL_CATALOG));
  const steps = Array.isArray(data?.steps) ? data.steps.map((step, index) => ({
    id: String(step.id || `s${index + 1}`).slice(0, 24),
    title: String(step.title || `Step ${index + 1}`).slice(0, 90),
    task: String(step.task || '').slice(0, 5000),
    model: MODEL_CATALOG[job.selectedModel] ? job.selectedModel : (allowed.has(step.model) ? step.model : 'reasoning'),
    modelName: MODEL_CATALOG[job.selectedModel]?.label || MODEL_CATALOG[allowed.has(step.model) ? step.model : 'reasoning'].label,
  })).filter(step => step.task) : [];
  if (steps.length) return { objective: String(data.objective || job.request).slice(0, 1000), reason: String(data.reason || '').slice(0, 800), steps };
  const fallback = fallbackPlan(job.request);
  if (MODEL_CATALOG[job.selectedModel]) fallback.steps.forEach(step => { step.model = job.selectedModel; step.modelName = MODEL_CATALOG[job.selectedModel].label; });
  return fallback;
}

async function runPy(code, files) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [process.cwd() + '/runner/py.mjs'], { env: { PATH: process.env.PATH }, cwd: process.cwd() });
    let output = '', stderr = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ error: 'Timed out after 90s' }); }, 90_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ error: 'Python runner failed: ' + error.message }));
    child.on('close', () => {
      const marker = output.split('@@RESULT@@')[1];
      try { finish(marker ? JSON.parse(marker) : { error: 'Python runner failed: ' + stderr.slice(-400) }); }
      catch (error) { finish({ error: 'Could not parse Python output: ' + error.message }); }
    });
    child.stdin.end(JSON.stringify({ code, files }));
  });
}

const T = (name, description, props = {}, required = Object.keys(props)) => ({
  type: 'function', function: { name, description, parameters: {
    type: 'object', properties: Object.fromEntries(Object.entries(props).map(([key, value]) => [key, { type: 'string', description: value }])), required,
  } },
});
const TOOLS = [
  T('web_search', 'Search the web. Returns up to five titles, URLs and short snippets. Reuse search results and avoid repeated queries.', { query: 'search query' }),
  T('fetch_url', 'Fetch a web page and return its text.', { url: 'full https URL' }),
  T('run_javascript', 'Run synchronous JavaScript (3s limit). Use console.log for output; last expression is returned.', { code: 'JavaScript code' }),
  T('create_file', 'Create or overwrite a file in the workspace.', { path: 'file path', content: 'full file content' }),
  T('read_file', 'Read one relevant workspace file. Read each path only once unless you have edited it since the previous read; use the cached previous result instead of repeating the same read.', { path: 'file path' }),
  T('edit_file', 'Replace one exact unique string in a file.', { path: 'file path', old_str: 'exact text to replace', new_str: 'replacement' }),
  T('list_files', 'List workspace files. Usually call this once at the start; do not repeat unless files were created, deleted or renamed.', {}),
  T('terminal', 'Run a shell command in the workspace. File changes persist.', { command: 'shell command' }),
  T('run_python', 'Run Python 3 (Pyodide; packages auto-install from imports). Workspace changes are saved.', { code: 'Python code; use print() for output' }),
  T('present_file', 'Show a workspace file as a downloadable/openable card.', { path: 'file path', title: 'short title' }, ['path']),
  { type: 'function', function: { name: 'write_files', description: 'Create or overwrite several files at once.', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['files'] } } },
  { type: 'function', function: { name: 'spawn_subagents', description: 'Run up to 3 independent focused sub-agents in parallel. Use only when the workstreams do not overlap; do not create agents just to inspect files.', parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, task: { type: 'string' } }, required: ['name', 'task'] } } }, required: ['tasks'] } } },
];
const SUBTOOLS = TOOLS.filter(tool => !['spawn_subagents', 'present_file'].includes(tool.function.name));
const strip = value => String(value || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();

// A search provider that is rate limiting or unreachable. Callers stop retrying instead of waiting
// out a timeout again on every attempt.
export class SearchUnavailable extends Error {
  constructor(reason) { super(reason); this.name = 'SearchUnavailable'; }
}
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 7_000;
const SEARCH_DOWN_MS = 90_000;
const SEARCH_DOWN_NOTE = 'Live web search is temporarily unavailable. Do not retry searching. Continue with what you already know and any pages you can open with fetch_url, and tell the user that live search was unavailable.';
const isSearchOutage = error => error instanceof SearchUnavailable || ['TimeoutError', 'AbortError'].includes(error?.name) || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(error?.message || error));

export async function search(query) {
  if (process.env.TAVILY_API_KEY) {
    let response;
    try {
      response = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TAVILY_API_KEY },
        body: JSON.stringify({ query, max_results: 5 }), signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS + 1_000),
      });
    } catch (error) { throw isSearchOutage(error) ? new SearchUnavailable(`Tavily did not respond (${error.name || 'network error'}).`) : error; }
    if (response.status === 429 || response.status >= 500) throw new SearchUnavailable(`Tavily is unavailable (HTTP ${response.status}).`);
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const seen = new Set();
    return ((await response.json()).results || []).filter(item => {
      const key = String(item.url || '').split('#')[0];
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 5).map(item => ({ title: item.title, url: item.url, snippet: String(item.content || '').slice(0, 220) }));
  }
  let response;
  try {
    response = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kedabra/1.0)' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  } catch (error) { throw isSearchOutage(error) ? new SearchUnavailable(`DuckDuckGo did not respond within ${SEARCH_TIMEOUT_MS / 1000}s.`) : error; }
  // DuckDuckGo "soft blocks" servers by answering 202 (or 403/429) with a page that has no results.
  if ([202, 403, 429].includes(response.status) || response.status >= 500) throw new SearchUnavailable(`DuckDuckGo is rate limiting searches from this server (HTTP ${response.status}).`);
  const html = await response.text();
  const results = [], regex = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && results.length < 5) {
    const target = match[1].match(/uddg=([^&]+)/);
    results.push({ title: strip(match[2]), url: target ? decodeURIComponent(target[1]) : match[1], snippet: strip(match[3]) });
  }
  if (!results.length && /anomaly|captcha|unusual traffic|are you a human/i.test(html)) throw new SearchUnavailable('DuckDuckGo asked for a human check.');
  return results.length ? results : 'No results found for this query. Try different keywords.';
}

function runJS(code) {
  const logs = [], log = (...args) => logs.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  try {
    const result = vm.runInNewContext(code, { console: { log, error: log, warn: log, info: log }, Math, Date, JSON }, { timeout: 3_000 });
    return { logs: logs.join('\n'), result: result === undefined ? undefined : String(result) };
  } catch (error) { return { logs: logs.join('\n'), error: String(error) }; }
}

export async function runTool(name, args, { sid, send, tid, job, deadline, dead, modelId }) {
  switch (name) {
    case 'web_search': {
      const query = String(args.query || '').trim().slice(0, 500);
      const key = query.toLowerCase().replace(/\s+/g, ' ');
      job.webSearchCache ||= [];
      const cached = job.webSearchCache.find(item => item.key === key);
      if (cached) return { cached: true, results: cached.results };
      // After an outage, later searches in this task fail instantly instead of each waiting for a timeout.
      if ((job.searchDownUntil || 0) > Date.now()) return { error: SEARCH_DOWN_NOTE };
      job.webSearchCount = (job.webSearchCount || 0) + 1;
      let results;
      try { results = await search(query); }
      catch (error) {
        if (!isSearchOutage(error)) throw error;
        job.searchDownUntil = Date.now() + SEARCH_DOWN_MS;
        return { error: `${SEARCH_DOWN_NOTE} (${error.message})` };
      }
      job.webSearchCache.push({ key, results });
      return results;
    }
    case 'fetch_url': {
      let parsed;
      try { parsed = new URL(String(args.url || '')); } catch { return { error: 'A valid source URL is required.' }; }
      if (parsed.protocol !== 'https:') return { error: 'Only HTTPS source URLs are supported.' };
      const url = parsed.toString().split('#')[0];
      job.webFetchCache ||= [];
      const cached = job.webFetchCache.find(item => item.url === url);
      if (cached) return { cached: true, url, content: cached.content };
      job.webFetchCount = (job.webFetchCount || 0) + 1;
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kedabra/1.0)' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return { error: `Fetch failed (${response.status})` };
      const content = strip(await response.text()).slice(0, 4_500);
      job.webFetchCache.push({ url, content });
      return content;
    }
    case 'run_javascript': return runJS(args.code);
    case 'create_file': return writeFile(sid, args.path, args.content);
    case 'read_file': return (await readFile(sid, args.path)).slice(0, 12_000);
    case 'edit_file': {
      const content = await readFile(sid, args.path), matches = content.split(args.old_str).length - 1;
      if (matches !== 1) return { error: `old_str matched ${matches} times; it must match exactly once` };
      await writeFile(sid, args.path, content.replace(args.old_str, () => args.new_str));
      return { ok: true, path: args.path };
    }
    case 'list_files': return (await lsFiles(sid)).map(file => ({ path: file.path, size: file.size }));
    case 'terminal': return shell(sid, args.command);
    case 'run_python': {
      const snapshot = await getWorkspaceSnapshot(sid, {
        limit: 40,
        filter: Object.assign(file => file.size < 200_000 && !/\.(png|jpe?g|gif|pdf|zip|webp)$/i.test(file.path), { tag: 'python-small-text-files' }),
      });
      const files = snapshot.contents;
      const result = await runPy(args.code, files), saved = [];
      await Promise.all(Object.entries(result.changed || {}).map(async ([path, value]) => {
        await writeFile(sid, path, value.b64 ? Buffer.from(value.b64, 'base64') : value); saved.push(path);
      }));
      return { output: (result.out || '').slice(-6_000), error: result.error, files_saved: saved };
    }
    case 'write_files': return Promise.all((args.files || []).map(file => writeFile(sid, file.path, file.content)));
    case 'spawn_subagents': {
      const tasks = (args.tasks || []).slice(0, 3);
      return Promise.all(tasks.map(async (task, index) => {
        const subLabel = task.name || `agent-${index + 1}`;
        try {
          const subConversation = [
            { role: 'system', content: SUBSYS + '\n\nShared project memory:\n' + String(job.summary || '(no summary yet)').slice(0, 5_000) },
            { role: 'user', content: task.task },
          ];
          const result = await agentLoop(subConversation, { sid, send, job, deadline, dead, tools: SUBTOOLS, modelId, label: subLabel, nested: true });
          return { agent: subLabel, result };
        } catch (error) { return { agent: subLabel, error: error.message }; }
      }));
    }
    case 'present_file': {
      const target = args.path.replace(/^\/+/, '');
      const file = (await lsFiles(sid, target)).find(item => item.path === target);
      if (!file) return { error: 'No such file' };
      send({ t: 'file', path: file.path, url: file.url, title: args.title || file.path });
      return { presented: file.path };
    }
    default: return { error: 'Unknown tool: ' + name };
  }
}

async function compactStepConversation(conversation, { deadline, send, dead, modelId }) {
  const transcript = conversation.slice(2).map(message => {
    if (message.role === 'assistant' && message.tool_calls?.length) return `assistant tool calls: ${message.tool_calls.map(call => `${call.function.name}(${String(call.function.arguments || '').slice(0, 350)})`).join('; ')}`;
    return `${message.role}: ${String(message.content || '').slice(0, 1_200)}`;
  }).join('\n\n').slice(-7_000);
  const compact = await llm([
    { role: 'system', content: 'Summarize the current step execution so the same model can continue with minimal context. Preserve completed actions, file paths, important results, test outcomes, errors and next actions. Return plain text under 1,800 characters.' },
    { role: 'user', content: transcript },
  ], [], 'reasoning', { deadline, send, dead, maxTokens: 800 });
  conversation.splice(2, conversation.length - 2, { role: 'assistant', content: `COMPACT CURRENT-STEP MEMORY:\n${compact.msg.content.slice(0, 1_800)}` });
}

async function agentLoop(conversation, options) {
  const { sid, send, job, deadline, dead, tools, label = '', nested = false } = options;
  const selectedModel = options.modelId || 'reasoning';
  let activeModel = selectedModel;
  let progressOnlyCount = 0;

  // No fixed agent-round or tool-call count: continue until the model completes
  // the step, the user cancels, or this serverless invocation reaches its deadline.
  // Tool results are checkpointed so long-running work can resume in a fresh request.
  for (;;) {
    if (dead?.()) throw new CancelRun();
    if (Date.now() >= deadline) throw new PauseRun();

    // Resume any assistant tool calls that were checkpointed before a request paused.
    const previousToolMessage = [...conversation].reverse().find(message => message.role === 'assistant' && message.tool_calls?.length);
    const completedCallIds = new Set(conversation.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    let pendingCalls = previousToolMessage?.tool_calls?.filter(call => !completedCallIds.has(call.id)) || [];

    if (!pendingCalls.length) {
      const { msg, via, modelId: usedModel } = await llm(conversation, tools, activeModel, {
        deadline, send, dead,
        onText: nested ? undefined : options.onText,
      });
      if (!nested) send({ t: 'via', via, model: usedModel, modelName: MODEL_CATALOG[usedModel]?.label || usedModel });

      if (!msg.tool_calls?.length) {
        const answer = String(msg.content || '').trim();
        if (!answer || isProgressOnly(answer)) {
          progressOnlyCount++;
          if (!nested) send({ t: 'reset_delta' });
          conversation.push({ role: 'assistant', content: answer || '(The model returned no usable text.)' });
          conversation.push({
            role: 'user',
            content: 'That was only a progress statement, not the requested result. Continue the assigned task now. Use the available tools to perform the actual work, then return a concrete result. Do not repeat an intention or announce what you will do. Do not inspect files again if their contents are already in the conversation.',
          });
          if (progressOnlyCount >= 2) {
            const preferredAlternates = activeModel === 'coding' ? ['reasoning', 'gemini'] : activeModel === 'reasoning' ? ['gemini', 'coding'] : ['reasoning', 'coding'];
            const alternate = preferredAlternates.find(id => MODEL_CATALOG[id] && id !== activeModel);
            if (alternate) {
              activeModel = alternate;
              if (!nested) send({ t: 'agent_fallback', model: MODEL_CATALOG[alternate].label, detail: 'Switching models after repeated progress-only responses.' });
            }
          }
          if (progressOnlyCount >= 4) {
            return 'The selected models repeatedly returned progress narration instead of completing the assigned step. The task is not marked complete. Existing workspace changes, if any, have been preserved; retry the task or simplify the step.';
          }
          continue;
        }
        return answer;
      }

      conversation.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      pendingCalls = msg.tool_calls;
      if (!nested) await checkpoint(job);
    }

    // Searches and page fetches in one model turn do not depend on each other, so start them all
    // now and wait for the slowest instead of running them one after another.
    const inFlight = new Map();
    if (pendingCalls.length > 1) {
      for (const call of pendingCalls) {
        const name = call.function.name;
        if (name !== 'web_search' && name !== 'fetch_url') continue;
        const shareKey = name + ':' + call.function.arguments;
        if (!inFlight.has(shareKey)) {
          let parsed; try { parsed = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
          const promise = runTool(name, parsed, { sid, send, tid: call.id, job, deadline, dead, modelId: activeModel }).catch(error => ({ error: error.message }));
          inFlight.set(shareKey, promise);
        }
      }
    }

    for (const call of pendingCalls) {
      if (dead?.()) throw new CancelRun();
      if (Date.now() >= deadline) throw new PauseRun();
      job.stepToolCalls = (job.stepToolCalls || 0) + 1;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const name = call.function.name;
      if (!nested) send({ t: 'tool', id: call.id, name, args });
      else send({ t: 'sub', id: options.parentTid || '', line: `[${label}] ${name} ${String(Object.values(args)[0] || '').slice(0, 55)}` });

      let output, cachedRead = false;
      const readKey = nested ? null : readToolCacheKey(name, args, job.workspaceRevision || 0);
      const cached = readKey ? findCachedRead(job, readKey, job.stepIndex || 0) : null;
      if (cached) {
        cachedRead = true;
        output = cached.sameStep
          ? { cached: true, note: 'This exact read was already completed in this step and the earlier result is in the tool history. Do not call it again; continue the task.', previousReadLength: cached.output.length, repeatedReadNumber: cached.hits }
          : `CACHED WORKSPACE READ (unchanged since step ${cached.previousStep + 1}):\n${cached.output}`;
      } else {
        const started = inFlight.get(name + ':' + call.function.arguments);
        try { output = started ? await started : await runTool(name, args, { sid, send, tid: call.id, job, deadline, dead, modelId: activeModel }); }
        catch (error) { output = { error: error.message }; }
        if (readKey) {
          const serializedForCache = typeof output === 'string' ? output : JSON.stringify(output);
          rememberRead(job, readKey, serializedForCache, job.stepIndex || 0);
        }
        if (toolMutatesWorkspace(name, args)) {
          job.workspaceRevision = (job.workspaceRevision || 0) + 1;
          job.stepReadCache = [];
        }
      }

      const serialized = (typeof output === 'string' ? output : JSON.stringify(output)) ?? '';
      if (!nested) send({ t: 'result', id: call.id, out: serialized.slice(0, 1_500), cached: cachedRead });
      if (!nested) {
        job.stepActions ||= [];
        job.stepActions.push({ tool: name, input: JSON.stringify(args).slice(0, 450), result: serialized.slice(0, 1_100), cached: cachedRead });
        if (job.stepActions.length > 24) job.stepActions.splice(0, job.stepActions.length - 24);
      }
      conversation.push({ role: 'tool', tool_call_id: call.id, name, content: serialized.slice(0, MAX_TOOL_OUTPUT) });
      if (!nested) await checkpoint(job);

    }

    if (!nested && conversation.length > 14) {
      await compactStepConversation(conversation, { deadline, send, dead, modelId: activeModel });
      await checkpoint(job);
    }
  }
}

// Each running task is owned by one worker; only the owner may save it (see saveJobData).
const owners = new WeakMap();
async function checkpoint(job, { release = false } = {}) {
  job.updatedAt = Date.now();
  await saveJobData(job.sid, job.jobId, job, owners.get(job) || '', { release });
}

async function summarizeStep(job, deadline, send, dead) {
  const step = job.plan.steps[job.stepIndex];
  const actions = (job.stepActions || []).map((action, index) => `${index + 1}. ${action.tool}(${action.input}) -> ${action.result}`).join('\n');
  const files = (await lsFiles(job.sid)).map(file => `${file.path} (${file.size} bytes)`).slice(0, 100).join('\n');
  const readPaths = [...new Set((job.stepActions || []).filter(action => action.tool === 'read_file').map(action => { try { return JSON.parse(action.input).path; } catch { return ''; } }).filter(Boolean))];
  const changedPaths = [...new Set((job.stepActions || []).filter(action => ['create_file', 'edit_file', 'write_files', 'terminal', 'run_python'].includes(action.tool)).map(action => action.input))];
  const payload = `PREVIOUS RUNNING SUMMARY:\n${job.summary || '(none)'}\n\nVISUAL REFERENCE ANALYSIS:\n${job.visualContext || '(none)'}\n\nCOMPLETED STEP:\n${step.title}\nInstructions: ${step.task}\nSelected model: ${step.model}\n\nSTEP RESULT:\n${job.stepResult || '(no final text)'}\n\nFILES READ IN THIS STEP (avoid rereading unless changed):\n${readPaths.join('\n') || '(none)'}\n\nWORKSPACE-MUTATING TOOL CALLS:\n${changedPaths.join('\n') || '(none)'}\n\nTOOLS AND OBSERVED RESULTS:\n${actions || '(no tools used)'}\n\nCURRENT WORKSPACE FILES:\n${files || '(empty)'}`;
  const response = await llm([{ role: 'system', content: SUMMARY_SYS }, { role: 'user', content: payload.slice(-8_000) }], [], 'reasoning', { deadline, send, dead, maxTokens: 1_000 });
  return response.msg.content.trim().slice(0, 5_000) || `${job.summary}\nCompleted ${step.title}: ${job.stepResult}`.slice(-5_000);
}

async function finalAnswer(job, deadline, send, dead) {
  const steps = job.plan.steps.map((step, index) => `${index + 1}. ${step.title} [${step.modelName || step.model}]`).join('\n');
  const prompt = `USER'S ORIGINAL REQUEST:
${job.request}

EXECUTION PLAN:
${steps}

COMPACT EXECUTION SUMMARY (source of truth):
${job.summary}

Write the final response to the user. Clearly state what was completed, key files/results, tests actually run, and any remaining limitations. Do not repeat internal planning details unless useful. Do not claim anything not supported by the summary. Do not say what you are about to do. Do not output progress narration such as "I'll start by inspecting"; describe actual results or clearly say the task remains incomplete.`;
  const system = SYS + '\nFINAL-ANSWER RULE: Your response must report completed work or explicitly explain what prevented completion. Never return a statement of future intent or a progress update.';

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) send({ t: 'reset_all_text' });
    const response = await llm([
      { role: 'system', content: system },
      { role: 'user', content: prompt + (attempt ? '\n\nYour previous answer was only a progress statement. Write the actual final status now, using only the completed results above.' : '') },
    ], [], 'reasoning', {
      deadline, send, dead, maxTokens: 1_300,
      onText: text => send({ t: 'delta', text }),
    });
    const answer = String(response.msg.content || '').trim();
    if (answer && !isProgressOnly(answer)) return answer;
  }

  send({ t: 'reset_all_text' });
  const completed = (job.completedSteps || []).map((step, index) => `${index + 1}. ${step.title}: ${String(step.result || '').slice(0, 650)}`).join('\n\n');
  const latest = job.stepResult ? String(job.stepResult).slice(0, 900) : '';
  const evidence = completed || latest || String(job.summary || '').slice(-1_800);
  return `The work was checkpointed, but Kedabra could not produce a reliable final summary. The task should be treated as incomplete until the status below is reviewed.\n\n${evidence || 'No completed step result was saved.'}`;
}

function sendStatus(send, status, detail = '') { send({ t: 'status', status, detail }); }

async function inspectImagesWithRetries(request, images, { deadline, send, dead }) {
  let attempt = 0, waitMs = 1_500, lastError = 'Vision provider unavailable.';
  for (;;) {
    if (dead?.()) throw new CancelRun();
    if (Date.now() >= deadline) throw new PauseRun('Visual analysis is checkpointed for the next request.');
    try { return await analyzeImages(request, images); }
    catch (error) {
      lastError = String(error?.message || error);
      attempt++;
      send({ t: 'retry', attempt, model: 'vision', waitMs, detail: lastError, keyCount: groqKeys.length + (GOOGLE_KEY ? 1 : 0) });
      const remaining = deadline - Date.now();
      if (remaining <= 1_000) throw new PauseRun('Visual analysis will resume in the next request.');
      await sleep(Math.min(waitMs, remaining));
      waitMs = Math.min(Math.round(waitMs * 1.7), 15_000);
    }
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ models: {
    reasoning: { available: groqKeys.length > 0, model: MODELS.reasoning, provider: 'Groq' },
    coding: { available: groqKeys.length > 0, model: MODELS.coding, provider: 'Groq' },
    gemini: { available: Boolean(GOOGLE_KEY), model: MODELS.gemini, provider: 'Google' },
  } });
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  // The workspace id comes from the signed session, never from the request body.
  // Only the server's own signed continuation request supplies it (verified below).
  let sid;
  if (body.background) sid = String(body.sid || '').slice(0, 100);
  else { const user = requireUser(req, res); if (!user) return; sid = user.sid; }
  const jobId = String(body.jobId || '').replace(/[^\w-]/g, '').slice(0, 100);
  if (!jobId) return res.status(400).json({ error: 'Missing jobId.' });

  // Closing the tab no longer stops a task, so Stop sends an explicit signal.
  if (body.action === 'cancel') {
    try { await requestJobCancel(sid, jobId); return res.status(200).json({ ok: true }); }
    catch (error) { return res.status(500).json({ error: error.message || String(error) }); }
  }

  // Server-to-server continuation: answer immediately, keep working after the
  // response via waitUntil, so no browser needs to stay connected.
  if (body.background) {
    if (!validContinueToken(sid, jobId, req.headers['x-kedabra-continue'])) return res.status(403).json({ error: 'Invalid continuation token.' });
    res.status(202).json({ accepted: true });
    runtime.waitUntil(runJob({ req, res, body, sid, jobId, background: true }).catch(() => {}));
    return;
  }
  return runJob({ req, res, body, sid, jobId, background: false });
}

// Status events for a runner that is attaching to a job another runner owns.
// Only idempotent event types are sent (not "plan"), because the client appends plans.
function sendAttached(send, job) {
  const step = job?.plan?.steps?.[job.stepIndex];
  if (step) send({ t: 'step', index: job.stepIndex, total: job.plan.steps.length, title: step.title, model: step.model, modelName: step.modelName || MODEL_CATALOG[step.model]?.label || step.model, status: 'running' });
  sendStatus(send, 'Running in the background', 'This task is continuing on the server. This view updates when the next step finishes.');
}

async function runJob({ req, res, body, sid, jobId, background }) {
  const owner = randomUUID();
  // clientGone only stops streaming to the browser. It never stops the task.
  let clientGone = false, cancelled = false, holdsLease = false, stopWatcher = () => {};
  if (!background) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    req.on('aborted', () => { clientGone = true; });
    res.on('close', () => { if (!res.writableEnded) clientGone = true; });
    res.flushHeaders?.();
  }
  const send = event => { if (!background && !clientGone && !res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
  const isDead = () => cancelled;
  const deadline = Date.now() + INVOCATION_BUDGET_MS;
  let job;
  let incomingImages = [];

  // End this invocation with progress saved and schedule the next one on the server.
  const pause = async detail => {
    // A Stop that arrived between watcher polls must not schedule another hop.
    if (cancelled || await isJobCancelRequested(sid, jobId)) {
      cancelled = true; job.status = 'cancelled'; await checkpoint(job, { release: true }); return;
    }
    job.status = 'paused';
    job.hops = (job.hops || 0) + 1;
    await checkpoint(job, { release: true });
    if (detail) send({ t: 'paused', detail });
    if (shouldContinueInBackground(job)) scheduleContinuation({ req, sid, jobId });
  };
  const replaySettled = () => {
    if (job.phase === 'completed') {
      if (job.finalAnswer) { send({ t: 'reset_all_text' }); send({ t: 'delta', text: job.finalAnswer }); }
      send({ t: 'done', answer: job.finalAnswer || '' });
      return true;
    }
    if (job.status === 'failed') { send({ t: 'error', error: job.error || 'The task failed.' }); return true; }
    return false;
  };

  try {
    let row = await getJobRow(sid, jobId);
    if (row?.cancelRequested) {
      // Stop was pressed. Mark the task cancelled unless another worker still holds it
      // (that worker sees the flag and stops itself).
      if (row.job && row.job.status !== 'cancelled' && await claimJob(sid, jobId, owner, LEASE_MS)) {
        owners.set(row.job, owner); row.job.status = 'cancelled';
        await checkpoint(row.job, { release: true });
      }
      return;
    }
    job = row?.job || null;
    if (!job) {
      const messages = Array.isArray(body.messages) ? body.messages.filter(message => message?.content || message?.role === 'user').slice(-14) : [];
      const lastUserIndex = messages.map(message => message.role).lastIndexOf('user');
      const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : null;
      incomingImages = validateImages(body.images || lastUser?.attachments || []);
      const rawRequest = lastUser ? String(lastUser.content || '') : String(body.request || '');
      const requestedModel = String(body.modelId || 'auto');
      const modelAvailable = requestedModel === 'auto' || (requestedModel === 'gemini' ? Boolean(GOOGLE_KEY) : ['reasoning', 'coding'].includes(requestedModel) && groqKeys.length > 0);
      if (!modelAvailable) throw new Error(`The selected model (${requestedModel}) is not configured. Check the provider API key in Vercel environment variables.`);
      const requestText = rawRequest.trim() || (incomingImages.length ? 'Inspect the attached visual references and use them to complete the task.' : '');
      if (!requestText.trim()) throw new Error('No user request was supplied.');
      const history = messages.slice(0, lastUserIndex).slice(-10).map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '').slice(0, 2_500) }));
      job = {
        sid, jobId, request: requestText.slice(0, 20_000), history, selectedModel: requestedModel, webSearch: Boolean(body.webSearch),
        phase: incomingImages.length ? 'vision' : (history.length ? 'context' : 'planning'), plan: null, stepIndex: 0, summary: '',
        visualContext: '', visualModel: '', visualImageCount: incomingImages.length, visualFiles: incomingImages.map(image => image.name),
        stepConversation: null, stepResult: '', stepActions: [], stepToolCalls: 0, stepReadCache: [], workspaceRevision: 0, completedSteps: [], status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
        hops: 0, errorRetries: 0,
      };
      const created = await createJobRow(sid, jobId, job, owner, Date.now() + LEASE_MS);
      if (created) { owners.set(job, owner); holdsLease = true; }
      else {
        // A duplicate request created it first; continue from what is stored.
        row = await getJobRow(sid, jobId);
        if (!row || row.cancelRequested || !row.job) { job = null; return; }
        job = row.job;
      }
    }
    if (!holdsLease && job.phase === 'vision' && !job.visualContext) {
      incomingImages = validateImages(body.images || []);
      if (!incomingImages.length) throw new Error('Visual references are needed to resume this task. Reattach the image(s) and retry.');
    }

    if (replaySettled()) return;

    // Take the lock so a browser and a background hop never run the same task at once.
    // The database grants it to exactly one of any number of simultaneous requests.
    if (!holdsLease) {
      if (!(await claimJob(sid, jobId, owner, LEASE_MS))) { sendAttached(send, job); job = null; return; }
      holdsLease = true;
      // Re-read after claiming: another worker may have saved progress since we first looked.
      const fresh = await getJobRow(sid, jobId);
      if (!fresh?.job || fresh.cancelRequested) { await releaseJob(sid, jobId, owner); holdsLease = false; return; }
      job = fresh.job;
      owners.set(job, owner);
      if (replaySettled()) { await releaseJob(sid, jobId, owner); holdsLease = false; return; }
      job.status = 'running';
    }
    stopWatcher = startCancelWatcher(sid, jobId, () => { cancelled = true; });

    while (!cancelled && Date.now() < deadline) {
      if (job.phase === 'vision') {
        sendStatus(send, 'Inspecting visual references', 'Sending the attached images to a vision-capable model before planning the task.');
        const visual = await inspectImagesWithRetries(
          `The user's request is: ${job.request}\n\nAnalyze the attached image references for this task. Provide a detailed, implementation-ready visual specification. For UI screenshots, describe hierarchy, layout, spacing, alignment, typography, colors, visible text, controls, states, and inconsistencies. For design references, identify style, composition, objects, materials, and important proportions. For diagrams or charts, explain structure and labels. Clearly separate visible facts from uncertain interpretations. Focus on details that a coding or reasoning model can act on.`,
          incomingImages,
          { deadline, send, dead: isDead },
        );
        job.visualContext = String(visual.text || '').slice(0, 8_000);
        job.visualModel = `${visual.label || 'Vision model'} · ${visual.model || 'unknown model'}`;
        job.visualImageCount = incomingImages.length;
        job.visualFiles = incomingImages.map(image => image.name);
        job.phase = job.history.length ? 'context' : 'planning';
        await checkpoint(job);
        send({ t: 'vision_context', summary: job.visualContext, model: job.visualModel, count: job.visualImageCount, files: job.visualFiles });
        incomingImages = [];
      }

      if (job.phase === 'context') {
        sendStatus(send, 'Summarizing conversation context', 'Compressing earlier decisions and project state before planning this task.');
        job.summary = await summarizeHistory(job, deadline, send, isDead);
        job.history = [];
        job.phase = 'planning';
        await checkpoint(job);
      }

      if (job.phase === 'planning') {
        sendStatus(send, directPlan(job.request) ? 'Starting focused response' : 'Planning task');
        job.plan = await makePlan(job, deadline, send, isDead);
        job.phase = 'executing';
        await checkpoint(job);
        send({ t: 'plan', plan: job.plan });
      }

      if (job.phase === 'executing') {
        if (job.stepIndex >= job.plan.steps.length) {
          job.phase = 'finalizing'; await checkpoint(job); continue;
        }
        const step = job.plan.steps[job.stepIndex];
        send({ t: 'step', index: job.stepIndex, total: job.plan.steps.length, title: step.title, model: step.model, modelName: step.modelName || MODEL_CATALOG[step.model]?.label || step.model, status: 'running' });
        if (!job.stepConversation) {
          const context = String(job.summary || '(No prior execution context.)').slice(-7_000);
          job.stepConversation = [
            { role: 'system', content: SYS + (job.webSearch ? '\n\nThe user enabled web search for this request. Use web_search for relevant current facts and provide direct source links in the final response.' : '') + '\n\nIMPORTANT CONTEXT RULE: Use only the compact project memory below for prior work. Do not expect the full chat or earlier tool transcript. Update files based on the actual workspace state.\n\nCOMPACT PROJECT MEMORY:\n' + context + '\n\nVISUAL REFERENCE ANALYSIS (use these as the visual source of truth; images were inspected before planning):\n' + String(job.visualContext || '(No visual references attached.)').slice(0, 8_000) },
            { role: 'user', content: `OVERALL OBJECTIVE:\n${job.plan.objective}\n\nCURRENT STEP (${job.stepIndex + 1}/${job.plan.steps.length}): ${step.title}\n${step.task}\n\nComplete this step, use tools as needed, verify your work, and report concrete results.` },
          ];
          job.stepActions = [];
          job.stepToolCalls = 0;
          job.stepReadCache ||= [];
          job.workspaceRevision ||= 0;
          await checkpoint(job);
        }
        job.stepResult = await agentLoop(job.stepConversation, { sid, send, job, deadline, dead: isDead, tools: TOOLS, modelId: step.model });
        send({ t: 'step_done', index: job.stepIndex, title: step.title });
        // For a one-step task, the execution model has already produced the
        // user-facing answer. An extra summary/finalization call is pure cost
        // and can replace a complete result with another progress statement.
        if (job.plan.steps.length === 1 && job.stepResult && !isProgressOnly(job.stepResult)) {
          job.finalAnswer = job.stepResult;
          job.phase = 'completed'; job.status = 'completed';
          await checkpoint(job, { release: true });
          send({ t: 'done', answer: job.finalAnswer });
          return;
        }
        job.phase = 'summarizing';
        await checkpoint(job);
      }

      if (job.phase === 'summarizing') {
        sendStatus(send, 'Updating project memory', `Summarizing ${job.plan.steps[job.stepIndex].title} so later steps receive only the useful context.`);
        job.summary = await summarizeStep(job, deadline, send, isDead);
        job.completedSteps.push({ title: job.plan.steps[job.stepIndex].title, result: String(job.stepResult || '').slice(0, 1_500) });
        send({ t: 'summary', summary: job.summary });
        job.stepIndex++;
        job.stepConversation = null;
        job.stepResult = '';
        job.stepActions = [];
        job.phase = 'executing';
        await checkpoint(job);
      }

      if (job.phase === 'finalizing') {
        sendStatus(send, 'Preparing final response', 'Using the compact execution summary rather than replaying the full tool history.');
        job.finalAnswer = await finalAnswer(job, deadline, send, isDead);
        job.phase = 'completed'; job.status = 'completed';
        await checkpoint(job, { release: true });
        send({ t: 'done', answer: job.finalAnswer });
        return;
      }
    }

    if (cancelled) throw new CancelRun();
    await pause('Saved progress. Continuing in a fresh serverless request.');
  } catch (error) {
    try {
      if (error instanceof LeaseLostError) {
        holdsLease = false; // another worker owns the task now; stop quietly
      } else if (error instanceof PauseRun) {
        if (job && holdsLease) await pause('All available model routes are being retried. Progress is checkpointed.');
      } else if (error instanceof CancelRun) {
        if (job && holdsLease) { job.status = 'cancelled'; await checkpoint(job, { release: true }); }
      } else {
        const message = error.message || String(error);
        if (job && holdsLease && background && (job.errorRetries || 0) < 3) {
          // A transient infrastructure error should not silently end an unattended task.
          job.errorRetries = (job.errorRetries || 0) + 1;
          job.lastError = message;
          await pause();
        } else {
          send({ t: 'error', error: message });
          if (job && holdsLease) { job.status = 'failed'; job.error = message; await checkpoint(job, { release: true }); }
        }
      }
    } catch { /* the original outcome is already reported or will be retried */ }
  } finally {
    stopWatcher();
    if (!res.writableEnded) res.end();
  }
}
