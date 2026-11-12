import { listFiles, readFileBytes, readFilesBytes, putFile, removeFiles } from './_store.js';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const root = s => `ws/${String(s || 'anon').replace(/[^\w-]/g, '')}/`; // cache key only; files are keyed by sid in the database
export const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.+\/?/g, '').replace(/\/+/g, '/');
const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', md: 'text/markdown', svg: 'image/svg+xml', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', py: 'text/x-python' };
export const contentTypeFor = p => {
  const ext = norm(p).split('.').pop().toLowerCase();
  return (TYPES[ext] || 'text/plain') + (TYPES[ext]?.startsWith('image/') && ext !== 'svg' ? '' : '; charset=utf-8');
};
// Files are served by /api/file, which checks the signed-in session.
export const fileUrl = p => '/api/file?path=' + encodeURIComponent(p);
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Reuse workspace downloads during a single warm function instance. Terminal and
// Python tools often need the same source files; re-downloading them per call is wasteful.
const snapshotCache = new Map();
const snapshotInflight = new Map();
const workspaceVersions = new Map();
const cacheKey = sid => root(sid);
function invalidateWorkspace(sid) {
  const key = cacheKey(sid);
  workspaceVersions.set(key, (workspaceVersions.get(key) || 0) + 1);
  for (const id of snapshotCache.keys()) if (id.startsWith(key + '|')) snapshotCache.delete(id);
}

export async function getWorkspaceSnapshot(sid, { limit = 200, filter = null } = {}) {
  const key = cacheKey(sid);
  const version = workspaceVersions.get(key) || 0;
  const filterTag = filter?.tag || 'all';
  const snapshotId = `${key}|${limit}|${filterTag}`;
  const cached = snapshotCache.get(snapshotId);
  if (cached && cached.expiresAt > Date.now() && cached.version === version) return cached.snapshot;
  if (cached && cached.expiresAt <= Date.now()) snapshotCache.delete(snapshotId);
  const inflight = snapshotInflight.get(snapshotId);
  if (inflight && inflight.version === version) return inflight.promise;
  const promise = (async () => {
    const listed = await lsFiles(sid);
    const selected = listed.filter(file => !filter || filter.test(file)).slice(0, limit);
    const found = await readFilesBytes(sid, selected.map(file => file.path));
    const pairs = selected.map(file => [file.path, found.has(file.path) ? found.get(file.path).toString('utf8') : `\n[Could not load ${file.path}: file not found]`]);
    const snapshot = { files: selected, contents: Object.fromEntries(pairs) };
    if ((workspaceVersions.get(key) || 0) === version) {
      snapshotCache.set(snapshotId, { version, snapshot, expiresAt: Date.now() + 45_000 });
      while (snapshotCache.size > 6) snapshotCache.delete(snapshotCache.keys().next().value);
    }
    return snapshot;
  })();
  snapshotInflight.set(snapshotId, { version, promise });
  try { return await promise; }
  finally { if (snapshotInflight.get(snapshotId)?.promise === promise) snapshotInflight.delete(snapshotId); }
}

export async function lsFiles(sid, prefix = '') {
  return (await listFiles(sid, norm(prefix))).map(f => ({ path: f.path, size: f.size, url: fileUrl(f.path) }));
}
export const findFile = async (sid, p) => (await lsFiles(sid, p)).find(f => f.path === norm(p));

async function readSnapshotFile(sid, p) {
  const target = norm(p);
  const snapshot = await getWorkspaceSnapshot(sid, { limit: 200 });
  if (Object.prototype.hasOwnProperty.call(snapshot.contents, target)) return snapshot.contents[target];
  return readFile(sid, target);
}

export async function readFile(sid, p) {
  const content = await readFileBytes(sid, norm(p));
  if (!content) throw new Error('No such file: ' + p);
  return content.toString('utf8');
}
export async function writeFile(sid, p, content) {
  const path = norm(p);
  if (!path) throw new Error('A file path is required.');
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (data.length > MAX_FILE_BYTES) throw new Error(`${path} is too large (${(data.length / 1048576).toFixed(1)} MB). Files can be at most ${MAX_FILE_BYTES / 1048576} MB.`);
  await putFile(sid, path, data);
  invalidateWorkspace(sid);
  return { path, url: fileUrl(path), size: String(content).length };
}
export async function rmPath(sid, p) {
  const removed = await removeFiles(sid, norm(p));
  if (removed) invalidateWorkspace(sid);
  return removed;
}

const tok = s => (s.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/g) || []).map(t => (/^["']/.test(t) ? t.slice(1, -1).replace(/\\n/g, '\n') : t));

// Real sh (coreutils, sed, awk, find, node) in a throwaway dir with no secrets; changes sync back to the workspace.
export async function realShell(sid, cmd) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ws-')), before = {};
  try {
    const snapshot = await getWorkspaceSnapshot(sid, { limit: 200 });
    await Promise.all(snapshot.files.map(async f => {
      const t = snapshot.contents[f.path] ?? '';
      const p = join(dir, f.path); before[f.path] = t;
      await fs.mkdir(dirname(p), { recursive: true }); await fs.writeFile(p, t);
    }));
    let out;
    try { const r = await exec('sh', ['-c', cmd], { cwd: dir, timeout: 30000, maxBuffer: 2e6, env: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: dir } }); out = r.stdout + r.stderr; }
    catch (e) { out = (e.stdout || '') + (e.stderr || '') + (e.killed ? '\n(timed out after 30s)' : ''); }
    const after = {};
    for (const rel of await fs.readdir(dir, { recursive: true })) {
      const p = join(dir, rel); if (!(await fs.stat(p)).isFile()) continue;
      const t = await fs.readFile(p, 'utf8'); after[rel] = 1;
      if (before[rel] !== t) await writeFile(sid, rel, t);
    }
    for (const k of Object.keys(before)) if (!after[k]) await rmPath(sid, k);
    return out.trim() || '(done)';
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function one(sid, line) {
  if (!/^(pwd|mkdir|touch|ls|cat|echo|printf|head|tail|wc|rm|cp|mv|grep|help)\b/.test(line) || /[|;`$<&]/.test(line) || (/>/.test(line) && !/^(echo|printf|cat)\b/.test(line))) return realShell(sid, line);
  let redir = null;
  const rm = line.match(/^(.*?)\s*(>>?)\s*("[^"]+"|'[^']+'|\S+)\s*$/s);
  if (rm && /^(echo|printf|cat)\b/.test(line)) { line = rm[1]; redir = { app: rm[2] === '>>', p: tok(rm[3])[0] }; }
  const [c, ...a] = tok(line);
  const args = a.filter(x => !x.startsWith('-'));
  let o = '';
  switch (c) {
    case 'pwd': o = '/'; break;
    case 'mkdir': case 'touch': for (const f of args) if (c === 'touch' && !(await findFile(sid, f))) await writeFile(sid, f, ''); break;
    case 'ls': o = (await lsFiles(sid, args[0] || '')).map(f => `${f.path}  (${f.size}b)`).join('\n') || '(empty)'; break;
    case 'cat': o = (await Promise.all(args.map(f => readSnapshotFile(sid, f)))).join(''); break;
    case 'echo': o = a.join(' ') + '\n'; break;
    case 'printf': o = a.join(' '); break;
    case 'head': case 'tail': {
      const n = a.includes('-n') ? +a[a.indexOf('-n') + 1] : 10;
      const l = (await readSnapshotFile(sid, args[args.length - 1])).split('\n');
      o = (c === 'head' ? l.slice(0, n) : l.slice(-n)).join('\n'); break;
    }
    case 'wc': { const t = await readSnapshotFile(sid, args[0]); o = `${t.split('\n').length} lines, ${t.split(/\s+/).filter(Boolean).length} words, ${t.length} chars`; break; }
    case 'rm': { const n = []; for (const f of args) n.push(await rmPath(sid, f)); o = `removed ${n.reduce((x, y) => x + y, 0)} file(s)`; break; }
    case 'cp': case 'mv': {
      const t = await readFile(sid, args[0]); await writeFile(sid, args[1], t);
      if (c === 'mv') await rmPath(sid, args[0]); break;
    }
    case 'grep': {
      const re = new RegExp(args[0], a.includes('-i') ? 'i' : '');
      const files = args.length > 1 ? args.slice(1).map(f => ({ path: f })) : await lsFiles(sid);
      const snapshot = await getWorkspaceSnapshot(sid, { limit: 200 });
      for (const f of files) (snapshot.contents[f.path] ?? await readFile(sid, f.path)).split('\n').forEach((l, i) => re.test(l) && (o += `${f.path}:${i + 1}:${l}\n`));
      o = o || '(no matches)'; break;
    }
    case 'help': o = 'ls cat echo printf head tail wc rm cp mv touch mkdir grep pwd  (supports > and >> with echo/cat)'; break;
    default: o = `${c}: command not found (try help)`;
  }
  if (redir) { const prev = redir.app && (await findFile(sid, redir.p)) ? await readFile(sid, redir.p) : ''; await writeFile(sid, redir.p, prev + o); return ''; }
  return o;
}
export async function shell(sid, cmd) {
  const out = [];
  for (const line of String(cmd).split(/\n|&&/).map(s => s.trim()).filter(Boolean)) {
    try { out.push(await one(sid, line)); } catch (e) { out.push('error: ' + e.message); }
  }
  return out.join('\n').trim() || '(done)';
}
