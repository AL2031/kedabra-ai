// All persistent state lives here, in a Turso (libSQL/SQLite) database:
//   users  - accounts
//   jobs   - task checkpoints, plus the lock ("lease") and Stop flag for each task
//   files  - each account's workspace files
//
// Why SQL: every "only if nobody else has it" rule below is a single atomic
// statement (INSERT ... ON CONFLICT DO NOTHING, or UPDATE ... WHERE), so two servers
// can never both win a race. Rows written are metered by Turso, not API calls.
//
// Production uses libSQL's HTTP client (no native code). file: URLs use the Node
// build, which is how the tests run against a real SQLite file.
const DAY = 86_400_000;

export class StoreNotConfiguredError extends Error {
  constructor() { super('The database is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.'); this.name = 'StoreNotConfiguredError'; }
}
// Thrown when a worker tries to save a task that another worker now owns.
export class LeaseLostError extends Error {
  constructor() { super('This task is now being run by another worker.'); this.name = 'LeaseLostError'; }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     username TEXT PRIMARY KEY, id TEXT NOT NULL, sid TEXT NOT NULL, hash TEXT NOT NULL,
     created_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS jobs (
     sid TEXT NOT NULL, job_id TEXT NOT NULL, data TEXT, updated_at INTEGER NOT NULL,
     lease_owner TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
     cancel_requested INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sid, job_id))`,
  `CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at)`,
  `CREATE TABLE IF NOT EXISTS files (
     sid TEXT NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (sid, path))`,
];

export const storeConfigured = () => Boolean(process.env.TURSO_DATABASE_URL);

let dbPromise = null;
export const resetStore = () => { dbPromise = null; };

function db() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.TURSO_DATABASE_URL;
      if (!url) throw new StoreNotConfiguredError();
      // Two literal import() calls so the bundler includes exactly what it needs.
      const { createClient } = /^(file:|:memory:)/.test(url) ? await import('@libsql/client') : await import('@libsql/client/web');
      const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
      await client.batch(SCHEMA, 'write');
      return client;
    })().catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}
const run = async (sql, args = []) => (await db()).execute({ sql, args });
const bytes = value => (value == null ? null : Buffer.from(value));

// ---- Users ------------------------------------------------------------------------------
const userOf = row => !row ? null : ({
  id: row.id, username: row.username, sid: row.sid, hash: row.hash,
  createdAt: Number(row.created_at), failCount: Number(row.fail_count), lockedUntil: Number(row.locked_until),
});
export async function getUser(username) {
  return userOf((await run('SELECT * FROM users WHERE username = ?', [username])).rows[0]);
}
// Returns false if the username already exists (atomic: two signups cannot both win).
export async function insertUser(user) {
  const result = await run(
    'INSERT INTO users (username, id, sid, hash, created_at, fail_count, locked_until) VALUES (?, ?, ?, ?, ?, 0, 0) ON CONFLICT(username) DO NOTHING',
    [user.username, user.id, user.sid, user.hash, user.createdAt || Date.now()]);
  return result.rowsAffected === 1;
}
// Counts a failed login in one statement, so simultaneous guesses cannot undercount.
// SQLite evaluates every SET expression against the row as it was before the update.
export async function recordLoginFailure(username, maxFails, lockMs, now = Date.now()) {
  await run(
    `UPDATE users SET
       fail_count = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE fail_count + 1 END,
       locked_until = CASE WHEN fail_count + 1 >= ? THEN ? ELSE locked_until END
     WHERE username = ?`,
    [maxFails, maxFails, now + lockMs, username]);
}
export async function updateUserAuth(user) {
  await run('UPDATE users SET hash = ?, fail_count = ?, locked_until = ? WHERE username = ?',
    [user.hash, user.failCount || 0, user.lockedUntil || 0, user.username]);
}

// ---- Tasks (checkpoints, lease, Stop flag) -----------------------------------------------------
export async function getJobRow(sid, jobId) {
  const row = (await run('SELECT data, lease_owner, lease_until, cancel_requested FROM jobs WHERE sid = ? AND job_id = ?', [sid, jobId])).rows[0];
  if (!row) return null;
  return {
    job: row.data ? JSON.parse(row.data) : null,
    leaseOwner: row.lease_owner || '', leaseUntil: Number(row.lease_until),
    cancelRequested: Boolean(row.cancel_requested),
  };
}

// Creates the task already leased to `owner`. Returns false if it already exists.
// Also forgets tasks untouched for 30 days so the table does not grow forever.
export async function createJobRow(sid, jobId, job, owner, leaseUntil, now = Date.now()) {
  const results = await (await db()).batch([
    { sql: 'DELETE FROM jobs WHERE updated_at < ?', args: [now - 30 * DAY] },
    { sql: 'INSERT INTO jobs (sid, job_id, data, updated_at, lease_owner, lease_until) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sid, job_id) DO NOTHING',
      args: [sid, jobId, JSON.stringify(job), now, owner, leaseUntil] },
  ], 'write');
  return results[1].rowsAffected === 1;
}

// Saves a checkpoint. Only the current lease holder may write (the fence), so a slow
// worker that lost its lease cannot overwrite the new owner's progress.
export async function saveJobData(sid, jobId, job, owner, { release = false, now = Date.now() } = {}) {
  const result = await run(
    `UPDATE jobs SET data = ?, updated_at = ?${release ? ", lease_owner = '', lease_until = 0" : ''}
     WHERE sid = ? AND job_id = ? AND (lease_owner = ? OR lease_owner = '' OR lease_until <= ?)`,
    [JSON.stringify(job), now, sid, jobId, owner || '', now]);
  if (result.rowsAffected !== 1) throw new LeaseLostError();
}

// Atomically takes the lease if it is free, expired, or already ours. Exactly one
// of any number of simultaneous callers gets `true`.
export async function claimJob(sid, jobId, owner, leaseMs, now = Date.now()) {
  const result = await run(
    `UPDATE jobs SET lease_owner = ?, lease_until = ?
     WHERE sid = ? AND job_id = ? AND (lease_owner = '' OR lease_until <= ? OR lease_owner = ?)`,
    [owner, now + leaseMs, sid, jobId, now, owner]);
  return result.rowsAffected === 1;
}
export async function releaseJob(sid, jobId, owner) {
  await run("UPDATE jobs SET lease_owner = '', lease_until = 0 WHERE sid = ? AND job_id = ? AND lease_owner = ?", [sid, jobId, owner]);
}

// Stop. Works even before the task row exists (Stop pressed instantly): it leaves a
// marker the task sees as soon as it starts.
export async function requestJobCancel(sid, jobId, now = Date.now()) {
  await run(
    'INSERT INTO jobs (sid, job_id, data, updated_at, cancel_requested) VALUES (?, ?, NULL, ?, 1) ON CONFLICT(sid, job_id) DO UPDATE SET cancel_requested = 1',
    [sid, jobId, now]);
}
export async function isJobCancelRequested(sid, jobId) {
  const row = (await run('SELECT cancel_requested FROM jobs WHERE sid = ? AND job_id = ?', [sid, jobId])).rows[0];
  return Boolean(row && row.cancel_requested);
}
export const leaseHeldByOther = (row, owner, now = Date.now()) =>
  Boolean(row && row.leaseOwner && row.leaseOwner !== owner && row.leaseUntil > now);

// ---- Workspace files (paths arrive already normalised) ------------------------------------------------
const charLength = text => Array.from(text).length; // SQLite counts characters, not UTF-16 units

export async function listFiles(sid, prefix = '', limit = 1000) {
  const rows = (await run(
    'SELECT path, LENGTH(content) AS size FROM files WHERE sid = ? AND substr(path, 1, ?) = ? ORDER BY path LIMIT ?',
    [sid, charLength(prefix), prefix, limit])).rows;
  return rows.map(row => ({ path: row.path, size: Number(row.size) }));
}
export async function readFileBytes(sid, path) {
  return bytes((await run('SELECT content FROM files WHERE sid = ? AND path = ?', [sid, path])).rows[0]?.content);
}
// Many files in few queries (a workspace snapshot would otherwise be one query per file).
export async function readFilesBytes(sid, paths) {
  const found = new Map();
  for (let i = 0; i < paths.length; i += 300) {
    const chunk = paths.slice(i, i + 300);
    const rows = (await run(`SELECT path, content FROM files WHERE sid = ? AND path IN (${chunk.map(() => '?').join(',')})`, [sid, ...chunk])).rows;
    for (const row of rows) found.set(row.path, bytes(row.content));
  }
  return found;
}
export async function putFile(sid, path, content, now = Date.now()) {
  await run(
    'INSERT INTO files (sid, path, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(sid, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at',
    [sid, path, content, now]);
}
// Removes the file at `path`, or everything under it when it is a folder.
export async function removeFiles(sid, path) {
  const folder = path + '/';
  return (await run('DELETE FROM files WHERE sid = ? AND (path = ? OR substr(path, 1, ?) = ?)', [sid, path, charLength(folder), folder])).rowsAffected;
}
