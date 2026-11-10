/** Small, deterministic guardrails for agent execution. */

export function isProgressOnly(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/```/.test(text)) return false;

  // The final-answer path must reject promises to continue researching, not just
  // the narrower "I'll inspect..." wording. This was allowing progress updates
  // such as "I'll retry the web research now" to be shown as completed answers.
  const announcesIntent = /^(?:(?:okay|alright|sure|great)[,.! ]*)?(?:i(?:'|’)ll|i will|let me|i(?:'|’)m going to|i am going to|first[,. ]+(?:i(?:'|’)ll|i will|let me)|to start[,. ]+(?:i(?:'|’)ll|i will|let me))\b/i.test(text);
  const describesPreparation = /\b(?:start|begin|inspect|review|check|look|examine|analy[sz]e|investigate|explore|open|read|trace|take a look|search|research|retry|fetch|compare|gather|verify|continue|work on|dig into)\b/i.test(text);
  if (announcesIntent && describesPreparation) return true;

  // Common non-first-person progress/opening lines should not be accepted as
  // a final answer either.
  if (/^(?:i(?:'|’)m|i am)\s+(?:currently\s+)?(?:searching|researching|checking|looking|fetching|gathering|working|continuing|retrying)\b/i.test(text)) return true;
  if (/^(?:here(?:'s| is) what i(?:'|’)ll do|next i(?:'|’)ll|now i(?:'|’)ll|let(?:'|’)s start by)\b/i.test(text)) return true;

  const danglingResearch = text.length > 55 && text.length < 240 && !/[.!?]\s*$/.test(text)
    && /\b(?:news|announcements?|updates?)\b/i.test(text)
    && !/\b(?:is|are|was|were|announced|announces|released|launches|says|said|includes?|reports?|reported|reveals?|according)\b/i.test(text);
  if (danglingResearch) return true;

  // Reject a dangling heading or an obviously truncated one-line fragment.
  if (text.length < 100 && /(?:\b(?:this week|latest|news|announcements?)\s*[:—-]?\s*)$/i.test(text)) return true;
  return false;
}

export function readToolCacheKey(name, args, revision = 0) {
  if (name === 'terminal') {
    const command = String(args?.command || '').trim().replace(/\s+/g, ' ');
    if (!isReadOnlyTerminalCommand(command)) return null;
    return `${Number(revision) || 0}:terminal:${command}`;
  }
  if (name !== 'read_file' && name !== 'list_files') return null;
  const normalized = name === 'read_file'
    ? String(args?.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
    : 'workspace';
  return `${Number(revision) || 0}:${name}:${normalized}`;
}

function isReadOnlyTerminalCommand(command) {
  return /^(?:pwd|ls|cat|head|tail|wc|grep|help)(?:\s|$)/i.test(command) && !/[>;&|`]/.test(command);
}

export function findCachedRead(job, key, stepIndex = 0) {
  if (!key) return null;
  const entry = (job?.stepReadCache || []).find(item => item.key === key);
  if (!entry) return null;
  const previousStep = entry.lastStep;
  const sameStep = previousStep === stepIndex;
  entry.hits = (entry.hits || 0) + 1;
  entry.lastStep = stepIndex;
  return { ...entry, previousStep, sameStep };
}

export function rememberRead(job, key, output, stepIndex = 0, maxEntries = 14, maxChars = 12_000) {
  if (!job || !key) return;
  const value = String(output ?? '');
  if (value.length > maxChars) return;
  job.stepReadCache ||= [];
  job.stepReadCache = job.stepReadCache.filter(item => item.key !== key);
  job.stepReadCache.push({ key, output: value, hits: 0, lastStep: stepIndex, savedAt: Date.now() });
  if (job.stepReadCache.length > maxEntries) job.stepReadCache.splice(0, job.stepReadCache.length - maxEntries);
}

export function toolMutatesWorkspace(name, args = {}) {
  if (['create_file', 'edit_file', 'write_files', 'run_python', 'spawn_subagents'].includes(name)) return true;
  if (name !== 'terminal') return false;
  // Unknown commands are treated as mutating because they may write files.
  return !isReadOnlyTerminalCommand(String(args?.command || '').trim());
}
