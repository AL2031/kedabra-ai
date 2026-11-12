import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, clearTables } from './helpers/db.js';

useTempDb();
const lib = await import('../api/_lib.js');
const { signSession } = await import('../api/_auth.js');
const { default: handler } = await import('../api/file.js');
beforeEach(clearTables);

const cookieFor = sid => 'kd_session=' + signSession({ uid: 'u-' + sid, sid, username: sid });
function makeRes() {
  const state = { status: 200, headers: {}, body: undefined, ended: false };
  const res = {
    state, setHeader(k, v) { state.headers[k.toLowerCase()] = v; },
    status(c) { state.status = c; return res; }, json(b) { state.body = b; state.ended = true; return res; },
    end(b) { state.body = b; state.ended = true; return res; },
  };
  return res;
}
const get = async (path, sid) => {
  const res = makeRes();
  await handler({ method: 'GET', headers: { host: 'app.example.com', ...(sid ? { cookie: cookieFor(sid) } : {}) }, query: path === undefined ? {} : { path } }, res);
  return res.state;
};

test('the owner can fetch a file, served with safe headers', async () => {
  await lib.writeFile('alice', 'site/index.html', '<h1>hi</h1><script>alert(1)</script>');
  const r = await get('site/index.html', 'alice');
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.body).toString(), '<h1>hi</h1><script>alert(1)</script>');
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /sandbox/);       // generated HTML cannot run scripts here
  assert.equal(r.headers['cache-control'], 'private, no-store');
});

test('binary files are returned byte for byte with an image type', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  await lib.writeFile('alice', 'chart.png', png);
  const r = await get('chart.png', 'alice');
  assert.equal(r.headers['content-type'], 'image/png');
  assert.deepEqual([...Buffer.from(r.body)], [...png]);
});

test('files cannot be read without a session or by another account', async () => {
  await lib.writeFile('alice', 'private.txt', 'alice only');
  assert.equal((await get('private.txt')).status, 401);
  assert.equal((await get('private.txt', 'bob')).status, 404);
  assert.equal((await get('private.txt', 'alice')).status, 200);
});

test('missing files, missing paths and path tricks are handled', async () => {
  await lib.writeFile('alice', 'a.txt', 'A');
  assert.equal((await get('nope.txt', 'alice')).status, 404);
  assert.equal((await get(undefined, 'alice')).status, 400);
  const sneaky = await get('../../a.txt', 'alice');                      // normalised to a.txt inside the workspace
  assert.equal(sneaky.status, 200);
  const other = await get('../bob/a.txt', 'alice');                      // cannot reach another workspace
  assert.equal(other.status, 404);
});

test('only GET is allowed', async () => {
  const res = makeRes();
  await handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.state.status, 405);
});
