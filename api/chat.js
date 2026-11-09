import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { lsFiles, readFile, writeFile, shell, saveJob, loadJob, getWorkspaceSnapshot } from './_lib.js';
import { isProgressOnly, readToolCacheKey, findCachedRead, rememberRead, toolMutatesWorkspace } from './agent-guards.js';
import { analyzeImages, validateImages } from './vision.js';

const DAY = new Date().toDateString();
const SYS = `You are Kedabra, an expert AI engineer and assistant at kedabra.ai, running in a persistent cloud workspace.
Tools: web_search, fetch_url, run_python, run_javascript, create_file, write_files, read_file, edit_file, list_files, terminal, present_file, spawn_subagents.
Execution discipline: inspect the workspace once, then inspect only files relevant to the assigned task. Never read the same file or list the workspace repeatedly unless the file changed. A repeated read of the same path returns a cached result. Do not issue speculative or unrelated commands. Prefer one focused batch of file reads, then implement the task, then run focused tests and verify changed files. Do not narrate what you plan to do; actually do it. A progress announcement is not a deliverable. Preserve existing features unless asked to remove them. Never claim a test ran unless it did. Be concise and use markdown. Today is ${DAY}.`;
const PLANNER_SYS = `You are Kedabra's task planner and model router. Convert the user's request into an executable plan. Return ONLY valid JSON, no markdown.
Schema: {"objective":"...","reason":"...","steps":[{"id":"s1","title":"short label","task":"detailed self-contained instructions and success criteria","model":"reasoning|coding|gemini"}]}
Use 1 step for a simple direct answer, 1-3 steps for normal projects, and at most 5 for genuinely large multi-part work. Do not split inspection, implementation and verification into separate steps when one focused step can do them. Avoid steps that cause later models to re-inspect files already inspected. Make steps sequential only when later steps depend on earlier output. Prefer parallel subtasks only when truly independent and use spawn_subagents inside a step when useful. Select the lowest-cost model that can do each step reliably: reasoning for planning, explanation, synthesis and general tasks; coding for code creation, debugging, refactoring and tests; gemini only when a distinct model is a good fit and is listed as available. Model IDs must exactly match the available catalog. Do not invent models or use a model that is not listed. Keep each step concrete and independently actionable. Do not create unnecessary steps.`;
const CONTEXT_SYS = `You are Kedabra's conversation-memory summarizer. Compress the prior chat into a compact project memory for the next request. Preserve the user's durable instructions and preferences, active project facts, important decisions, relevant file names and interfaces, unresolved tasks and constraints. Prioritize recent messages over old ones. Exclude greetings, obsolete details and irrelevant tangents. Do not invent facts or imply work was completed unless the chat confirms it. Return only concise plain text, maximum 3,500 characters.`;
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
  gemini: process.env.GOOGLE_MODEL || 'gemini-2.5-flash',
};
const MODEL_CATALOG = {
  reasoning: { id: 'reasoning', model: MODELS.reasoning, provider: 'groq', purpose: 'planning, reasoning, general work and final synthesis' },
  coding: { id: 'coding', model: MODELS.coding, provider: 'groq', purpose: 'software engineering, code edits, debugging and tests' },
  ...(GOOGLE_KEY ? { gemini: { id: 'gemini', model: MODELS.gemini, provider: 'google', purpose: 'alternate model for suitable research and general tasks' } } : {}),
};
const badUntil = new Map();
let roundRobin = 0;
const INVOCATION_BUDGET_MS = 180_000;
const PROVIDER_TIMEOUT_MS = 14_000;
const MAX_AGENT_ROUNDS = 12;
const MAX_TOOL_CALLS_PER_STEP = 24;
const MAX_TOOL_OUTPUT = 8_000;
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
        list.push({ key, model: option.model, url: 'https://api.groq.com/openai/v1/chat/completions', name: `${option.model} · Groq key ${keyIndex}`, modelId: option.id });
      });
    } else if (option.provider === 'google' && GOOGLE_KEY) {
      list.push({ key: GOOGLE_KEY, model: option.model, url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', name: `${option.model} · Google`, modelId: option.id });
    }
  }
  const healthy = list.filter(item => !(badUntil.get(item.key + ':' + item.model) > Date.now()));
  return healthy.length ? healthy : list;
}

async function readStream(response, onText) {
  const msg = { content: '', tool_calls: [] };
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
      const delta = data.choices?.[0]?.delta;
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
        if (tool.function?.name) call.function.name += tool.function.name;
        if (tool.function?.arguments) call.function.arguments += tool.function.arguments;
      }
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  msg.content = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
  if (!sawDone && !msg.content && !msg.tool_calls.length) throw new Error('Provider closed the stream without a response.');
  if (!sawDone) throw new Error('Provider stream ended before completion; retrying the request.');
  return msg;
}

async function llm(messages, tools, modelId, { deadline, send, dead, onText } = {}) {
  let cycle = 0, backoff = 1_500, lastError = 'No API keys are configured.';
  for (;;) {
    if (dead?.()) throw new CancelRun();
    if (Date.now() >= deadline) throw new PauseRun();
    const available = candidates(modelId);
    if (!available.length) {
      lastError = 'No usable API keys are configured. Add a Groq or Google key in Vercel environment variables.';
    } else {
      for (const provider of available) {
        if (dead?.()) throw new CancelRun();
        if (Date.now() >= deadline) throw new PauseRun();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
        try {
          const body = {
            model: provider.model,
            messages,
            temperature: provider.modelId === 'coding' ? 0.2 : 0.45,
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
            if ([401, 403, 404].includes(status)) badUntil.set(provider.key + ':' + provider.model, Date.now() + 10 * 60_000);
            else if (status === 429) badUntil.set(provider.key + ':' + provider.model, Date.now() + 60_000);
            else if (status >= 500) badUntil.set(provider.key + ':' + provider.model, Date.now() + 30_000);
            throw new Error(`${provider.name} (${status}): ${errorText.slice(0, 180)}`);
          }
          const msg = await readStream(response, text => onText?.(text));
          if (!msg.content && !msg.tool_calls.length) throw new Error(`${provider.name} returned an empty response.`);
          if (cycle > 0) send?.({ t: 'retry_clear' });
          return { msg, via: provider.name, modelId: provider.modelId };
        } catch (error) {
          lastError = error?.name === 'AbortError' ? `${provider.name} timed out after ${PROVIDER_TIMEOUT_MS / 1000}s.` : String(error?.message || error);
          if (onText) send?.({ t: 'reset_delta' });
        } finally { clearTimeout(timeout); }
      }
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
    steps: [{ id: 's1', title: code ? 'Implement and verify' : 'Answer the request', task, model: code ? 'coding' : 'reasoning', modelName: MODEL_CATALOG[code ? 'coding' : 'reasoning'].model }],
  };
}

async function summarizeHistory(job, deadline, send, dead) {
  const history = (job.history || []).map(message => `${message.role}: ${String(message.content || '').slice(0, 2_500)}`).join('\n\n').slice(-10_000);
  const prompt = `PREVIOUS CHAT (oldest first; recent messages are most important):\n${history || '(none)'}\n\nCreate concise memory that will help answer the next request. Do not answer the current request yet.`;
  const response = await llm([{ role: 'system', content: CONTEXT_SYS }, { role: 'user', content: prompt }], [], 'reasoning', { deadline, send, dead });
  return response.msg.content.trim().slice(0, 3_500);
}

async function makePlan(job, deadline, send, dead) {
  const catalog = Object.values(MODEL_CATALOG).map(m => ({ id: m.id, model: m.model, purpose: m.purpose }));
  const prompt = `AVAILABLE MODELS:\n${JSON.stringify(catalog)}\n\nMODEL-SUMMARIZED CONVERSATION CONTEXT:\n${job.summary || '(none)'}\n\nVISUAL REFERENCES (already inspected by the multimodal model; treat these as source material):\n${job.visualContext || '(No images attached.)'}\n\nCURRENT USER REQUEST:\n${job.request}\n\nCreate the execution plan. Choose an exact model ID for every step. Keep related inspection, implementation and testing in the same step where practical. Include only the files and tools needed. Do not create multiple steps that would reread the same workspace files. If visual references are present, make sure implementation steps explicitly use their relevant details. Do not ask the coding model to infer details that are already established in the visual analysis.`;
  const response = await llm([{ role: 'system', content: PLANNER_SYS }, { role: 'user', content: prompt }], [], 'reasoning', { deadline, send, dead });
  const data = parseJsonObject(response.msg.content);
  const allowed = new Set(Object.keys(MODEL_CATALOG));
  const steps = Array.isArray(data?.steps) ? data.steps.slice(0, 6).map((step, index) => ({
    id: String(step.id || `s${index + 1}`).slice(0, 24),
    title: String(step.title || `Step ${index + 1}`).slice(0, 90),
    task: String(step.task || '').slice(0, 5000),
    model: allowed.has(step.model) ? step.model : 'reasoning',
    modelName: MODEL_CATALOG[allowed.has(step.model) ? step.model : 'reasoning'].model,
  })).filter(step => step.task) : [];
  return steps.length ? { objective: String(data.objective || job.request).slice(0, 1000), reason: String(data.reason || '').slice(0, 800), steps } : fallbackPlan(job.request);
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
  T('web_search', 'Search the web. Returns titles, URLs and snippets.', { query: 'search query' }),
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

async function search(query) {
  if (process.env.TAVILY_API_KEY) {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TAVILY_API_KEY },
      body: JSON.stringify({ query, max_results: 6 }), signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    return (await response.json()).results?.map(item => ({ title: item.title, url: item.url, snippet: String(item.content || '').slice(0, 300) })) || [];
  }
  const response = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kedabra/1.0)' }, signal: AbortSignal.timeout(12_000) });
  const html = await response.text();
  const results = [], regex = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && results.length < 8) {
    const target = match[1].match(/uddg=([^&]+)/);
    results.push({ title: strip(match[2]), url: target ? decodeURIComponent(target[1]) : match[1], snippet: strip(match[3]) });
  }
  return results.length ? results : 'No results (search provider may be rate limiting).';
}

function runJS(code) {
  const logs = [], log = (...args) => logs.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  try {
    const result = vm.runInNewContext(code, { console: { log, error: log, warn: log, info: log }, Math, Date, JSON }, { timeout: 3_000 });
    return { logs: logs.join('\n'), result: result === undefined ? undefined : String(result) };
  } catch (error) { return { logs: logs.join('\n'), error: String(error) }; }
}

async function runTool(name, args, { sid, send, tid, job, deadline, dead, modelId }) {
  switch (name) {
    case 'web_search': return search(args.query);
    case 'fetch_url': {
      const response = await fetch(args.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kedabra/1.0)' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return { error: `Fetch failed (${response.status})` };
      return strip(await response.text()).slice(0, 8_000);
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
  }).join('\n\n').slice(-13_000);
  const compact = await llm([
    { role: 'system', content: 'Summarize the current step execution so the same model can continue with minimal context. Preserve completed actions, file paths, important results, test outcomes, errors and next actions. Return plain text under 2,500 characters.' },
    { role: 'user', content: transcript },
  ], [], 'reasoning', { deadline, send, dead });
  conversation.splice(2, conversation.length - 2, { role: 'assistant', content: `COMPACT CURRENT-STEP MEMORY:\n${compact.msg.content.slice(0, 2_500)}` });
}

async function agentLoop(conversation, options) {
  const { sid, send, job, deadline, dead, tools, label = '', nested = false } = options;
  const selectedModel = options.modelId || 'reasoning';
  let activeModel = selectedModel;
  let progressOnlyCount = 0;

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (dead?.()) throw new CancelRun();

    // Resume any assistant tool calls that were checkpointed before a request paused.
    const previousToolMessage = [...conversation].reverse().find(message => message.role === 'assistant' && message.tool_calls?.length);
    const completedCallIds = new Set(conversation.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    let pendingCalls = previousToolMessage?.tool_calls?.filter(call => !completedCallIds.has(call.id)) || [];

    if (!pendingCalls.length) {
      const { msg, via, modelId: usedModel } = await llm(conversation, tools, activeModel, {
        deadline, send, dead,
        onText: nested ? undefined : options.onText,
      });
      if (!nested) send({ t: 'via', via, model: usedModel, modelName: MODEL_CATALOG[usedModel]?.model || usedModel });

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
            const alternate = activeModel === 'coding' ? 'reasoning' : 'coding';
            if (MODEL_CATALOG[alternate] && activeModel !== alternate) {
              activeModel = alternate;
              if (!nested) send({ t: 'agent_fallback', model: MODEL_CATALOG[alternate].model, detail: 'Switching models after repeated progress-only responses.' });
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

    for (const call of pendingCalls) {
      if (dead?.()) throw new CancelRun();
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
      } else if (job.stepToolCalls > MAX_TOOL_CALLS_PER_STEP) {
        output = { error: `Tool-call budget reached (${MAX_TOOL_CALLS_PER_STEP} calls for this step). Stop inspecting and unrelated experimentation; use the information already collected to complete the assigned task, or report the precise blocker.` };
      } else {
        try { output = await runTool(name, args, { sid, send, tid: call.id, job, deadline, dead, modelId: activeModel }); }
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

      // Do not let a model burn the remaining request on endless no-op tool calls.
      if (job.stepToolCalls >= MAX_TOOL_CALLS_PER_STEP + 4) {
        return 'The step stopped after reaching its tool-call safety limit. The workspace and completed tool results have been preserved, but the requested work was not verified as complete.';
      }
    }

    if (!nested && conversation.length > 14) {
      await compactStepConversation(conversation, { deadline, send, dead, modelId: activeModel });
      await checkpoint(job);
    }
  }
  return `The step reached its ${MAX_AGENT_ROUNDS}-round execution limit without producing a verified final result. Completed tool actions and workspace changes were preserved; the task is not marked complete.`;
}

async function checkpoint(job) {
  job.updatedAt = Date.now();
  await saveJob(job.sid, job.jobId, job);
}

async function summarizeStep(job, deadline, send, dead) {
  const step = job.plan.steps[job.stepIndex];
  const actions = (job.stepActions || []).map((action, index) => `${index + 1}. ${action.tool}(${action.input}) -> ${action.result}`).join('\n');
  const files = (await lsFiles(job.sid)).map(file => `${file.path} (${file.size} bytes)`).slice(0, 100).join('\n');
  const readPaths = [...new Set((job.stepActions || []).filter(action => action.tool === 'read_file').map(action => { try { return JSON.parse(action.input).path; } catch { return ''; } }).filter(Boolean))];
  const changedPaths = [...new Set((job.stepActions || []).filter(action => ['create_file', 'edit_file', 'write_files', 'terminal', 'run_python'].includes(action.tool)).map(action => action.input))];
  const payload = `PREVIOUS RUNNING SUMMARY:\n${job.summary || '(none)'}\n\nVISUAL REFERENCE ANALYSIS:\n${job.visualContext || '(none)'}\n\nCOMPLETED STEP:\n${step.title}\nInstructions: ${step.task}\nSelected model: ${step.model}\n\nSTEP RESULT:\n${job.stepResult || '(no final text)'}\n\nFILES READ IN THIS STEP (avoid rereading unless changed):\n${readPaths.join('\n') || '(none)'}\n\nWORKSPACE-MUTATING TOOL CALLS:\n${changedPaths.join('\n') || '(none)'}\n\nTOOLS AND OBSERVED RESULTS:\n${actions || '(no tools used)'}\n\nCURRENT WORKSPACE FILES:\n${files || '(empty)'}`;
  const response = await llm([{ role: 'system', content: SUMMARY_SYS }, { role: 'user', content: payload }], [], 'reasoning', { deadline, send, dead });
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
      deadline, send, dead,
      onText: text => send({ t: 'delta', text }),
    });
    const answer = String(response.msg.content || '').trim();
    if (answer && !isProgressOnly(answer)) return answer;
  }

  send({ t: 'reset_all_text' });
  const lastStep = job.stepResult ? `\n\nLast step report: ${String(job.stepResult).slice(0, 1_000)}` : '';
  return `Kedabra could not produce a reliable final summary. The task has not been confirmed as complete.\n\nSaved project context:\n${String(job.summary || 'No execution summary was saved.').slice(0, 3_500)}${lastStep}`;
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
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  const sid = String(body.sid || 'anon').slice(0, 100);
  const jobId = String(body.jobId || '').replace(/[^\w-]/g, '').slice(0, 100);
  if (!jobId) return res.status(400).json({ error: 'Missing jobId.' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = event => { if (!gone && !res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
  let gone = false;
  req.on('aborted', () => { gone = true; });
  res.on('close', () => { if (!res.writableEnded) gone = true; });
  res.flushHeaders?.();
  const deadline = Date.now() + INVOCATION_BUDGET_MS;
  let job;
  let incomingImages = [];

  try {
    job = await loadJob(sid, jobId);
    if (!job) {
      const messages = Array.isArray(body.messages) ? body.messages.filter(message => message?.content || message?.role === 'user').slice(-14) : [];
      const lastUserIndex = messages.map(message => message.role).lastIndexOf('user');
      const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : null;
      incomingImages = validateImages(body.images || lastUser?.attachments || []);
      const rawRequest = lastUser ? String(lastUser.content || '') : String(body.request || '');
      const requestText = rawRequest.trim() || (incomingImages.length ? 'Inspect the attached visual references and use them to complete the task.' : '');
      if (!requestText.trim()) throw new Error('No user request was supplied.');
      const history = messages.slice(0, lastUserIndex).slice(-10).map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '').slice(0, 2_500) }));
      job = {
        sid, jobId, request: requestText.slice(0, 20_000), history,
        phase: incomingImages.length ? 'vision' : (history.length ? 'context' : 'planning'), plan: null, stepIndex: 0, summary: '',
        visualContext: '', visualModel: '', visualImageCount: incomingImages.length, visualFiles: incomingImages.map(image => image.name),
        stepConversation: null, stepResult: '', stepActions: [], stepToolCalls: 0, stepReadCache: [], workspaceRevision: 0, completedSteps: [], status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
      };
      await checkpoint(job);
    } else if (job.phase === 'vision' && !job.visualContext) {
      incomingImages = validateImages(body.images || []);
      if (!incomingImages.length) throw new Error('Visual references are needed to resume this task. Reattach the image(s) and retry.');
    }

    if (job.phase === 'completed') {
      if (job.finalAnswer) { send({ t: 'reset_all_text' }); send({ t: 'delta', text: job.finalAnswer }); }
      send({ t: 'done', answer: job.finalAnswer || '' });
      return res.end();
    }

    while (!gone && Date.now() < deadline) {
      if (job.phase === 'vision') {
        sendStatus(send, 'Inspecting visual references', 'Sending the attached images to a vision-capable model before planning the task.');
        const visual = await inspectImagesWithRetries(
          `The user's request is: ${job.request}\n\nAnalyze the attached image references for this task. Provide a detailed, implementation-ready visual specification. For UI screenshots, describe hierarchy, layout, spacing, alignment, typography, colors, visible text, controls, states, and inconsistencies. For design references, identify style, composition, objects, materials, and important proportions. For diagrams or charts, explain structure and labels. Clearly separate visible facts from uncertain interpretations. Focus on details that a coding or reasoning model can act on.`,
          incomingImages,
          { deadline, send, dead: () => gone },
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
        job.summary = await summarizeHistory(job, deadline, send, () => gone);
        job.history = [];
        job.phase = 'planning';
        await checkpoint(job);
      }

      if (job.phase === 'planning') {
        sendStatus(send, 'Planning task', 'Choosing the model and splitting the request into executable steps.');
        job.plan = await makePlan(job, deadline, send, () => gone);
        job.phase = 'executing';
        await checkpoint(job);
        send({ t: 'plan', plan: job.plan });
      }

      if (job.phase === 'executing') {
        if (job.stepIndex >= job.plan.steps.length) {
          job.phase = 'finalizing'; await checkpoint(job); continue;
        }
        const step = job.plan.steps[job.stepIndex];
        send({ t: 'step', index: job.stepIndex, total: job.plan.steps.length, title: step.title, model: step.model, modelName: step.modelName || MODEL_CATALOG[step.model]?.model || step.model, status: 'running' });
        if (!job.stepConversation) {
          const context = String(job.summary || '(No prior execution context.)').slice(-7_000);
          job.stepConversation = [
            { role: 'system', content: SYS + '\n\nIMPORTANT CONTEXT RULE: Use only the compact project memory below for prior work. Do not expect the full chat or earlier tool transcript. Update files based on the actual workspace state.\n\nCOMPACT PROJECT MEMORY:\n' + context + '\n\nVISUAL REFERENCE ANALYSIS (use these as the visual source of truth; images were inspected before planning):\n' + String(job.visualContext || '(No visual references attached.)').slice(0, 8_000) },
            { role: 'user', content: `OVERALL OBJECTIVE:\n${job.plan.objective}\n\nCURRENT STEP (${job.stepIndex + 1}/${job.plan.steps.length}): ${step.title}\n${step.task}\n\nComplete this step, use tools as needed, verify your work, and report concrete results.` },
          ];
          job.stepActions = [];
          job.stepToolCalls = 0;
          job.stepReadCache ||= [];
          job.workspaceRevision ||= 0;
          await checkpoint(job);
        }
        job.stepResult = await agentLoop(job.stepConversation, { sid, send, job, deadline, dead: () => gone, tools: TOOLS, modelId: step.model });
        send({ t: 'step_done', index: job.stepIndex, title: step.title });
        if (job.plan.steps.length === 1 && !(job.stepActions || []).length && job.stepResult) {
          job.finalAnswer = job.stepResult;
          job.phase = 'completed'; job.status = 'completed';
          await checkpoint(job);
          send({ t: 'done', answer: job.finalAnswer });
          return res.end();
        }
        job.phase = 'summarizing';
        await checkpoint(job);
      }

      if (job.phase === 'summarizing') {
        sendStatus(send, 'Updating project memory', `Summarizing ${job.plan.steps[job.stepIndex].title} so later steps receive only the useful context.`);
        job.summary = await summarizeStep(job, deadline, send, () => gone);
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
        job.finalAnswer = await finalAnswer(job, deadline, send, () => gone);
        job.phase = 'completed'; job.status = 'completed';
        await checkpoint(job);
        send({ t: 'done', answer: job.finalAnswer });
        return res.end();
      }
    }

    if (gone) {
      job.status = 'paused';
      await checkpoint(job);
      return res.end();
    }
    job.status = 'paused';
    await checkpoint(job);
    send({ t: 'paused', detail: 'Saved progress. Continuing in a fresh serverless request.' });
  } catch (error) {
    if (error instanceof PauseRun) {
      if (job) { job.status = 'paused'; await checkpoint(job); }
      send({ t: 'paused', detail: 'All available model routes are being retried. Progress is checkpointed.' });
    } else if (error instanceof CancelRun || gone) {
      if (job) { job.status = 'paused'; await checkpoint(job); }
    } else {
      send({ t: 'error', error: error.message || String(error) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}
