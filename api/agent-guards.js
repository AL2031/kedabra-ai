/** Small, deterministic guardrails for agent execution. */

export function isProgressOnly(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 420) return false;
  if (/```|\b(?:completed|created|updated|fixed|tested|results?|here(?:'s| is)|the answer is)\b/i.test(text)) return false;

  const announcesIntent = /^(?:(?:okay|alright|sure)[,.! ]*)?(?:i(?:'|’)ll|i will|let me|i(?:'|’)m going to|i am going to|first[,. ]+(?:i(?:'|’)ll|i will|let me)|to start[,. ]+(?:i(?:'|’)ll|i will|let me))\b/i.test(text);
  const describesPreparation = /\b(?:start|begin|inspect|review|check|look|examine|analy[sz]e|investigate|explore|open|read|trace|take a look)\b/i.test(text);
  return announcesIntent && describesPreparation;
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
