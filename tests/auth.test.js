import test from 'node:test';
import assert from 'node:assert/strict';

import { useTempDb, clearTables } from './helpers/db.js';
useTempDb();
delete process.env.SIGNUP_CODE;
const auth = await import('../api/_auth.js');
const store = await import('../api/_store.js');
const { default: authHandler } = await import('../api/auth.js');
const { default: terminalHandler } = await import('../api/terminal.js');

function makeRes() {
  const res = { state: { status: 200, headers: {}, body: undefined } };
  Object.assign(res, {
    setHeader(k, v) { res.state.headers[k.toLowerCase()] = v; }, status(c) { res.state.status = c; return res; },
    json(b) { res.state.body = b; return res; }, end() { return res; },
  });
  return res;
}
const call = async (handler, { method = 'POST', body, headers = {} } = {}) => { const res = makeRes(); await handler({ method, body, headers: { host: 'app.example.com', ...headers } }, res); return res.state; };
const post = (body, headers) => call(authHandler, { body, headers });
const cookieFrom = state => (state.headers['set-cookie'] || []).find(c => c.startsWith('kd_session=')).split(';')[0];
const reset = async () => { await clearTables(); delete process.env.SIGNUP_CODE; };

test('passwords are salted scrypt hashes that verify only the right password', async () => {
  const a = await auth.hashPassword('correct horse'); const b = await auth.hashPassword('correct horse');
  assert.notEqual(a, b);                      // random salt per hash
  assert.match(a, /^scrypt\$/);
  assert.equal(a.includes('correct horse'), false);
  assert.equal(await auth.verifyPassword('correct horse', a), true);
  assert.equal(await auth.verifyPassword('correct horsf', a), false);
  assert.equal(await auth.verifyPassword('x', 'not-a-hash'), false);
});

test('usernames and passwords are validated', () => {
  assert.equal(auth.validateUsername('alice_01'), '');
  for (const bad of ['', 'ab', 'a'.repeat(33), 'has space', '-lead', 'ünïcode', 'a/b']) assert.notEqual(auth.validateUsername(bad), '', bad);
  assert.equal(auth.normalizeUsername('  AlIcE '), 'alice');
  assert.equal(auth.validatePassword('12345678'), '');
  assert.notEqual(auth.validatePassword('short'), '');
  assert.notEqual(auth.validatePassword('x'.repeat(201)), '');
  assert.notEqual(auth.validatePassword(12345678), '');
});

test('session tokens reject tampering, expiry and a different secret', () => {
  const token = auth.signSession({ uid: 'u1', sid: 's1', username: 'alice' });
  assert.deepEqual(auth.verifySession(token), { uid: 'u1', sid: 's1', username: 'alice' });
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'u1', sid: 'victim', u: 'alice', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(auth.verifySession(`${forged}.${sig}`), null);
  assert.equal(auth.verifySession(`${payload}.${sig.slice(0, -2)}xx`), null);
  assert.equal(auth.verifySession(token, Date.now() + 31 * 86_400_000), null);
  assert.equal(auth.verifySession(''), null);
  assert.equal(auth.verifySession(undefined), null);
  process.env.AUTH_SECRET = 'a-different-secret';
  assert.equal(auth.verifySession(token), null);
  process.env.AUTH_SECRET = 'test-auth-secret';
});

test('signup creates an account, sets HttpOnly session cookies, and never stores the plaintext password', async () => {
  await reset();
  const res = await post({ action: 'signup', username: 'Alice', password: 'hunter2hunter2' }, { 'x-forwarded-proto': 'https' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'alice');
  const cookies = res.headers['set-cookie'];
  const session = cookies.find(c => c.startsWith('kd_session='));
  assert.match(session, /HttpOnly/); assert.match(session, /SameSite=Lax/); assert.match(session, /Secure/);
  assert.equal(/HttpOnly/.test(cookies.find(c => c.startsWith('kd_user='))), false);   // page script reads this one
  const user = await store.getUser('alice');
  assert.match(user.hash, /^scrypt\$/);
  assert.equal(user.hash.includes('hunter2hunter2'), false);                           // no plaintext
  assert.equal(user.sid, user.id);                                                     // each account gets its own workspace id
  assert.equal(user.id.length, 36);
});

test('cookies are not marked Secure on localhost so local development works', async () => {
  await reset();
  const res = await call(authHandler, { body: { action: 'signup', username: 'localdev', password: 'localpassword' }, headers: { host: 'localhost:3000' } });
  assert.equal(res.headers['set-cookie'].some(c => /Secure/.test(c)), false);
});

test('usernames are unique regardless of case', async () => {
  await reset();
  assert.equal((await post({ action: 'signup', username: 'bob', password: 'password-one' })).status, 200);
  const dup = await post({ action: 'signup', username: 'BOB', password: 'password-two' });
  assert.equal(dup.status, 409);
});

test('login succeeds with the right password and gives the same error for wrong password and unknown user', async () => {
  await reset();
  await post({ action: 'signup', username: 'carol', password: 'carol-password' });
  const ok = await post({ action: 'login', username: 'carol', password: 'carol-password' });
  assert.equal(ok.status, 200);
  assert.ok(auth.verifySession(cookieFrom(ok).split('=')[1]));
  const wrong = await post({ action: 'login', username: 'carol', password: 'nope-nope-nope' });
  const unknown = await post({ action: 'login', username: 'nobody', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error);
  assert.equal(wrong.headers['set-cookie'], undefined);
});

test('five wrong passwords lock the account, then it unlocks after the lockout', async () => {
  await reset();
  await post({ action: 'signup', username: 'dave', password: 'dave-password' });
  for (let i = 0; i < 5; i++) assert.equal((await post({ action: 'login', username: 'dave', password: 'wrong-wrong' + i })).status, 401);
  const locked = await post({ action: 'login', username: 'dave', password: 'dave-password' });   // correct, but locked
  assert.equal(locked.status, 429);
  const user = await store.getUser('dave');
  await store.updateUserAuth({ ...user, lockedUntil: Date.now() - 1 });                          // lockout elapses
  assert.equal((await post({ action: 'login', username: 'dave', password: 'dave-password' })).status, 200);
});

test('simultaneous wrong guesses are all counted', async () => {
  await reset();
  await post({ action: 'signup', username: 'mallory-target', password: 'real-password' });
  await Promise.all(Array.from({ length: 5 }, () => post({ action: 'login', username: 'mallory-target', password: 'guess-guess' })));
  assert.equal((await post({ action: 'login', username: 'mallory-target', password: 'real-password' })).status, 429);
});

test('an invite code is required for signup when SIGNUP_CODE is set', async () => {
  await reset(); process.env.SIGNUP_CODE = 'open-sesame';
  assert.equal((await call(authHandler, { method: 'GET' })).body.signupCodeRequired, true);
  assert.equal((await post({ action: 'signup', username: 'erin', password: 'erin-password' })).status, 403);
  assert.equal((await post({ action: 'signup', username: 'erin', password: 'erin-password', inviteCode: 'wrong' })).status, 403);
  assert.equal(await store.getUser('erin'), null);
  assert.equal((await post({ action: 'signup', username: 'erin', password: 'erin-password', inviteCode: 'open-sesame' })).status, 200);
  assert.ok(await store.getUser('erin'));
});

test('two simultaneous signups for one username: exactly one succeeds', async () => {
  await reset();
  const results = await Promise.all([
    post({ action: 'signup', username: 'taylor', password: 'password-one' }),
    post({ action: 'signup', username: 'Taylor', password: 'password-two' }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});

test('every account gets a different workspace id', async () => {
  await reset();
  const a = await post({ action: 'signup', username: 'one-user', password: 'password-one' });
  const b = await post({ action: 'signup', username: 'two-user', password: 'password-two' });
  const sidA = auth.verifySession(cookieFrom(a).split('=')[1]).sid, sidB = auth.verifySession(cookieFrom(b).split('=')[1]).sid;
  assert.notEqual(sidA, sidB);
  const login = await post({ action: 'login', username: 'one-user', password: 'password-one' });
  assert.equal(auth.verifySession(cookieFrom(login).split('=')[1]).sid, sidA);       // stable across logins
});

test('GET reports the signed-in user or clears stale cookies', async () => {
  await reset();
  const signup = await post({ action: 'signup', username: 'ivan', password: 'ivan-password' });
  const me = await call(authHandler, { method: 'GET', headers: { cookie: cookieFrom(signup) } });
  assert.equal(me.body.user.username, 'ivan');
  assert.ok(me.headers['set-cookie']);                               // rolling refresh
  const anon = await call(authHandler, { method: 'GET', headers: { cookie: 'kd_session=garbage; kd_user=ivan' } });
  assert.equal(anon.body.user, null);
  assert.ok(anon.headers['set-cookie'].every(c => /Max-Age=0/.test(c)));
});

test('logout clears both cookies', async () => {
  await reset();
  const res = await post({ action: 'logout' });
  assert.equal(res.status, 200);
  assert.ok(res.headers['set-cookie'].every(c => /Max-Age=0/.test(c)));
});

test('cross-site POSTs are blocked', async () => {
  await reset();
  const res = await post({ action: 'login', username: 'x', password: 'y' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal((await post({ action: 'login', username: 'nobody', password: 'whatever1' }, { origin: 'https://app.example.com' })).status, 401);
});

test('protected routes reject signed-out requests and use the session workspace', async () => {
  await reset();
  assert.equal((await call(terminalHandler, { method: 'GET' })).status, 401);
  assert.equal((await call(terminalHandler, { body: { cmd: 'ls' } })).status, 401);
  const cookie = 'kd_session=' + auth.signSession({ uid: 'u', sid: 'ws-1', username: 'tester' });
  const ok = await call(terminalHandler, { method: 'GET', headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.files, []);
  assert.equal((await call(terminalHandler, { method: 'POST', body: { cmd: 'ls' }, headers: { cookie, origin: 'https://evil.example' } })).status, 403);
});

test('an administrator can reset a forgotten password and clear a lockout', async () => {
  await reset();
  await post({ action: 'signup', username: 'judy', password: 'old-password-1' });
  for (let i = 0; i < 5; i++) await post({ action: 'login', username: 'judy', password: 'bad-bad-bad' });
  assert.equal(await auth.setPassword('Judy', 'brand-new-password'), true);
  assert.equal((await post({ action: 'login', username: 'judy', password: 'old-password-1' })).status, 401);
  assert.equal((await post({ action: 'login', username: 'judy', password: 'brand-new-password' })).status, 200);
  assert.equal(await auth.setPassword('nobody', 'brand-new-password'), false);
  await assert.rejects(() => auth.setPassword('judy', 'short'));
});

test('missing configuration is reported clearly', async () => {
  const saved = { secret: process.env.AUTH_SECRET, token: process.env.TURSO_AUTH_TOKEN, url: process.env.TURSO_DATABASE_URL };
  try {
    delete process.env.AUTH_SECRET; delete process.env.TURSO_AUTH_TOKEN;
    const noKey = await post({ action: 'login', username: 'a', password: 'b' });
    assert.equal(noKey.status, 500); assert.match(noKey.body.error, /signing key/);
    process.env.AUTH_SECRET = saved.secret;
    delete process.env.TURSO_DATABASE_URL;
    const noDb = await post({ action: 'login', username: 'a', password: 'b' });
    assert.equal(noDb.status, 500); assert.match(noDb.body.error, /database is not configured/i);
  } finally {
    process.env.AUTH_SECRET = saved.secret; process.env.TURSO_DATABASE_URL = saved.url;
    if (saved.token) process.env.TURSO_AUTH_TOKEN = saved.token;
  }
});