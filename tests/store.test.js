import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, clearTables } from './helpers/db.js';

useTempDb();
const store = await import('../api/_store.js');
const lib = await import('../api/_lib.js');
before(clearTables);
beforeEach(clearTables);

// ---- Files ---------------------------------------------------------------------------------
test('files are written, listed with byte sizes, overwritten and read back', async () => {
  await lib.writeFile('a', 'src/app.js', 'héllo');
  await lib.writeFile('a', 'README.md', '# hi');
  const listed = await lib.lsFiles('a');
  assert.deepEqual(listed.map(f => f.path), ['README.md', 'src/app.js']);
  assert.equal(listed.find(f => f.path === 'src/app.js').size, 6);                // bytes, not characters
  assert.equal(listed[0].url, '/api/file?path=README.md');
  await lib.writeFile('a', 'src/app.js', 'v2');
  assert.equal(await lib.readFile('a', 'src/app.js'), 'v2');
  assert.equal((await lib.lsFiles('a')).length, 2);
  await assert.rejects(() => lib.readFile('a', 'nope.txt'), /No such file/);
});

test('binary files survive unchanged', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 0, 66]);
  await lib.writeFile('a', 'img/pixel.png', bytes);
  const back = await store.readFileBytes('a', 'img/pixel.png');
  assert.deepEqual([...back], [...bytes]);
});

test('workspaces are isolated from each other', async () => {
  await lib.writeFile('alice', 'secret.txt', 'alice only');
  assert.deepEqual(await lib.lsFiles('bob'), []);
  await assert.rejects(() => lib.readFile('bob', 'secret.txt'), /No such file/);
  assert.equal(await lib.rmPath('bob', 'secret.txt'), 0);
  assert.equal(await lib.readFile('alice', 'secret.txt'), 'alice only');
});

test('prefix listing and folder removal behave like the old file store', async () => {
  for (const p of ['src/a.js', 'src/b.js', 'src2/c.js', 'top.js']) await lib.writeFile('a', p, p);
  assert.deepEqual((await lib.lsFiles('a', 'src/')).map(f => f.path), ['src/a.js', 'src/b.js']);
  assert.equal(await lib.rmPath('a', 'src'), 2);                                   // folder removes its contents only
  assert.deepEqual((await lib.lsFiles('a')).map(f => f.path), ['src2/c.js', 'top.js']);
  assert.equal(await lib.rmPath('a', 'top.js'), 1);
});

test('paths are normalised and cannot escape, and oversized or empty paths are rejected', async () => {
  const result = await lib.writeFile('a', '../../etc/passwd', 'x');
  assert.equal(result.path, 'etc/passwd');
  await assert.rejects(() => lib.writeFile('a', '', 'x'), /path is required/);
  await assert.rejects(() => lib.writeFile('a', 'big.bin', Buffer.alloc(lib.MAX_FILE_BYTES + 1)), /too large/);
});

test('workspace snapshots return contents in one pass and see new writes', async () => {
  await lib.writeFile('a', 'one.txt', '1'); await lib.writeFile('a', 'two.txt', '2');
  const first = await lib.getWorkspaceSnapshot('a');
  assert.deepEqual(first.contents, { 'one.txt': '1', 'two.txt': '2' });
  await lib.writeFile('a', 'two.txt', 'changed');
  assert.equal((await lib.getWorkspaceSnapshot('a')).contents['two.txt'], 'changed');
});

test('the shell tools work on database-backed files', async () => {
  assert.equal((await lib.shell('a', 'echo hello > greet.txt')).trim(), '(done)');
  assert.equal((await lib.shell('a', 'cat greet.txt')).trim(), 'hello');
  assert.match(await lib.shell('a', 'ls'), /greet\.txt/);
  await lib.shell('a', 'mv greet.txt hi.txt');
  assert.deepEqual((await lib.lsFiles('a')).map(f => f.path), ['hi.txt']);
});

// ---- Users --------------------------------------------------------------------------------------
test('a username can be claimed once, even by simultaneous signups', async () => {
  const make = id => ({ id, username: 'sam', sid: id, hash: 'h' });
  const results = await Promise.all([1, 2, 3, 4, 5].map(i => store.insertUser(make('id' + i))));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.getUser('sam')).username, 'sam');
});

test('simultaneous failed logins are all counted and lock the account', async () => {
  await store.insertUser({ id: 'u', username: 'lee', sid: 'u', hash: 'h' });
  await Promise.all([1, 2, 3, 4, 5].map(() => store.recordLoginFailure('lee', 5, 60_000)));
  const user = await store.getUser('lee');
  assert.ok(user.lockedUntil > Date.now());
  assert.equal(user.failCount, 0);
  await store.recordLoginFailure('lee', 5, 60_000);
  assert.equal((await store.getUser('lee')).failCount, 1);
});

// ---- Tasks ------------------------------------------------------------------------------------------
const job = (extra = {}) => ({ sid: 's', jobId: 'j', status: 'running', phase: 'planning', ...extra });

test('a task row is created once and exposes its lease', async () => {
  assert.equal(await store.createJobRow('s', 'j', job(), 'A', Date.now() + 60_000), true);
  assert.equal(await store.createJobRow('s', 'j', job(), 'B', Date.now() + 60_000), false);
  const row = await store.getJobRow('s', 'j');
  assert.equal(row.leaseOwner, 'A');
  assert.equal(row.job.phase, 'planning');
  assert.equal(await store.getJobRow('s', 'missing'), null);
});

test('exactly one of many simultaneous workers wins the lock', async () => {
  await store.createJobRow('s', 'j', job(), '', 0);
  const wins = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claimJob('s', 'j', 'W' + i, 60_000)));
  assert.equal(wins.filter(Boolean).length, 1);
  const owner = (await store.getJobRow('s', 'j')).leaseOwner;
  assert.equal(await store.claimJob('s', 'j', 'someone-else', 60_000), false);   // held
  assert.equal(await store.claimJob('s', 'j', owner, 60_000), true);              // owner may renew
});

test('an expired lock can be taken over and only the owner can release it', async () => {
  await store.createJobRow('s', 'j', job(), 'A', Date.now() - 1_000);              // already expired
  assert.equal(await store.claimJob('s', 'j', 'B', 60_000), true);
  await store.releaseJob('s', 'j', 'A');                                           // not the owner: no effect
  assert.equal((await store.getJobRow('s', 'j')).leaseOwner, 'B');
  await store.releaseJob('s', 'j', 'B');
  assert.equal((await store.getJobRow('s', 'j')).leaseOwner, '');
});

test('only the lock holder can save progress (a stale worker is fenced out)', async () => {
  await store.createJobRow('s', 'j', job(), 'A', Date.now() + 60_000);
  await store.saveJobData('s', 'j', job({ phase: 'executing' }), 'A');
  assert.equal((await store.getJobRow('s', 'j')).job.phase, 'executing');
  await assert.rejects(() => store.saveJobData('s', 'j', job({ phase: 'stale' }), 'B'), store.LeaseLostError);
  assert.equal((await store.getJobRow('s', 'j')).job.phase, 'executing');
  await store.saveJobData('s', 'j', job({ phase: 'done' }), 'A', { release: true });
  const row = await store.getJobRow('s', 'j');
  assert.equal(row.leaseOwner, ''); assert.equal(row.leaseUntil, 0);
});

test('Stop works before the task exists and after it has started', async () => {
  await store.requestJobCancel('s', 'early');
  assert.equal(await store.isJobCancelRequested('s', 'early'), true);
  assert.equal(await store.createJobRow('s', 'early', job(), 'A', Date.now() + 1000), false);   // marker wins
  const row = await store.getJobRow('s', 'early');
  assert.equal(row.job, null); assert.equal(row.cancelRequested, true);
  await store.createJobRow('s', 'later', job(), 'A', Date.now() + 60_000);
  assert.equal(await store.isJobCancelRequested('s', 'later'), false);
  await store.requestJobCancel('s', 'later');
  assert.equal(await store.isJobCancelRequested('s', 'later'), true);
  assert.equal((await store.getJobRow('s', 'later')).job.phase, 'planning');          // data untouched
  assert.equal(await store.isJobCancelRequested('other-account', 'later'), false);
});

test('tasks untouched for 30 days are forgotten', async () => {
  const day = 86_400_000, t0 = Date.now() - 40 * day;
  await store.createJobRow('s', 'old', job(), '', 0, t0);
  assert.ok(await store.getJobRow('s', 'old'));
  await store.createJobRow('s', 'new', job(), '', 0, Date.now());
  assert.equal(await store.getJobRow('s', 'old'), null);
  assert.ok(await store.getJobRow('s', 'new'));
});

test('an unconfigured database is reported clearly', async () => {
  const url = process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_DATABASE_URL; store.resetStore();
  try {
    assert.equal(store.storeConfigured(), false);
    await assert.rejects(() => store.getUser('x'), store.StoreNotConfiguredError);
  } finally { process.env.TURSO_DATABASE_URL = url; store.resetStore(); }
});
