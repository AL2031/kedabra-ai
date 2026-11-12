import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { useTempDb, clearTables } from './helpers/db.js';

useTempDb();
const waited = [];
const bgModule = await import('../api/_background.js');
bgModule.runtime.waitUntil = p => { waited.push(p); };

process.env.GROQ_API_KEY_1 = 'test-groq-key';
process.env.INVOCATION_BUDGET_MS = '1500';
process.env.BACKGROUND_HOP_DELAY_MS = '0';
process.env.CANCEL_POLL_MS = '200';

let providerMode = 'answer';
let providerCalls = 0;
const continuationCalls = [];
const sse = parts => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const p of parts) c.enqueue(e.encode('data: ' + (typeof p === 'string' ? p : JSON.stringify(p)) + '\n\n')); c.close(); } }), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes('/api/chat')) { continuationCalls.push({ url, init }); return new Response('{}', { status: 202 }); }
  if (url.includes('groq.com')) {
    providerCalls++;
    if (providerMode === 'answer') return sse([{ choices: [{ delta: { content: 'Here is your answer.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
    // 'loop': keep calling a tool so the task never finishes inside one invocation.
    await new Promise(r => setTimeout(r, 250));
    return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + providerCalls, type: 'function', function: { name: 'list_files', arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
  }
  return realFetch(url, init);
};

const store = await import('../api/_store.js');
const { signSession } = await import('../api/_auth.js');
const bg = await import('../api/_background.js');
const { default: handler } = await import('../api/chat.js');

// Signed-in browser requests carry a session cookie for the workspace id in body.sid.
// (Server-to-server continuation requests authenticate with their own signed header.)
function makeReq(body, headers = {}) {
  const req = new EventEmitter();
  const cookie = !body.background && body.sid ? { cookie: 'kd_session=' + signSession({ uid: 'user-' + body.sid, sid: body.sid, username: 'tester' }) } : {};
  Object.assign(req, { method: 'POST', body, headers: { host: 'app.example.com', 'x-forwarded-proto': 'https', ...cookie, ...headers } });
  return req;
}
function makeRes() {
  const res = new EventEmitter();
  const state = { status: 200, chunks: [], ended: false, json: undefined };
  Object.assign(res, {
    state, get writableEnded() { return state.ended; },
    setHeader() {}, flushHeaders() {},
    status(code) { state.status = code; return res; },
    json(obj) { state.json = obj; state.ended = true; res.emit('close'); return res; },
    write(chunk) { state.chunks.push(chunk); return true; },
    end() { if (!state.ended) { state.ended = true; res.emit('close'); } return res; },
  });
  return res;
}
const events = res => res.state.chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rowOf = (sid, jobId) => store.getJobRow(sid, jobId);
const reset = async () => { await clearTables(); waited.length = 0; continuationCalls.length = 0; providerCalls = 0; };
const post = (sid, jobId, extra = {}) => ({ sid, jobId, messages: [{ role: 'user', content: 'Say hello' }], modelId: 'auto', ...extra });
const nextHop = () => ({ headers: continuationCalls[0].init.headers, body: JSON.parse(continuationCalls[0].init.body) });
const baseJob = (sid, jobId, extra = {}) => ({ sid, jobId, request: 'Say hello', history: [], selectedModel: 'auto', webSearch: false, phase: 'planning', plan: null, stepIndex: 0, summary: '', visualContext: '', stepConversation: null, stepResult: '', stepActions: [], completedSteps: [], status: 'paused', hops: 0, ...extra });

test('a task keeps running and completes after the browser disconnects', async () => {
  await reset(); providerMode = 'answer';
  const req = makeReq(post('s1', 'j1')); const res = makeRes();
  const running = handler(req, res);
  req.emit('aborted'); res.emit('close');   // the tab/computer goes away immediately
  await running;
  const { job, leaseOwner } = await rowOf('s1', 'j1');
  assert.equal(job.status, 'completed');
  assert.match(job.finalAnswer, /Here is your answer/);
  assert.equal(leaseOwner, '');
  assert.equal(continuationCalls.length, 0);
});

test('an unfinished invocation saves a checkpoint and schedules the next one on the server', async () => {
  await reset(); providerMode = 'loop';
  await handler(makeReq(post('s2', 'j2')), makeRes());
  const row = await rowOf('s2', 'j2');
  assert.equal(row.job.status, 'paused');
  assert.equal(row.leaseOwner, ''); assert.equal(row.leaseUntil, 0);
  assert.equal(row.job.hops, 1);
  assert.equal(waited.length, 1);
  await Promise.all(waited);
  assert.equal(continuationCalls.length, 1);
  const sent = continuationCalls[0];
  assert.equal(sent.url, 'https://app.example.com/api/chat');
  assert.equal(JSON.parse(sent.init.body).background, true);
  assert.ok(sent.init.headers['x-kedabra-continue']);
});

test('a background hop resumes the job, runs to completion, and needs no browser', async () => {
  await reset(); providerMode = 'loop';
  await handler(makeReq(post('s3', 'j3')), makeRes());
  await Promise.all(waited);
  const { headers, body } = nextHop();
  providerMode = 'answer'; waited.length = 0; continuationCalls.length = 0;
  const res = makeRes();
  await handler(makeReq(body, headers), res);
  assert.equal(res.state.status, 202);          // answered immediately
  await Promise.all(waited);                    // ...then worked via waitUntil
  const { job } = await rowOf('s3', 'j3');
  assert.equal(job.status, 'completed');
  assert.ok(job.finalAnswer);
});

test('continuation requests without a valid token are rejected', async () => {
  await reset();
  const res = makeRes();
  await handler(makeReq({ sid: 's4', jobId: 'j4', background: true }, { 'x-kedabra-continue': 'forged' }), res);
  assert.equal(res.state.status, 403);
  assert.equal(await rowOf('s4', 'j4'), null);
});

test('a second runner attaches instead of running while another holds the lock', async () => {
  await reset(); providerMode = 'answer';
  await store.createJobRow('s5', 'j5', baseJob('s5', 'j5', { status: 'running' }), 'other-runner', Date.now() + 120_000);
  const res = makeRes();
  await handler(makeReq(post('s5', 'j5')), res);
  assert.equal(providerCalls, 0);
  assert.ok(events(res).some(e => e.t === 'status' && /background/i.test(e.status)));
  assert.equal((await rowOf('s5', 'j5')).leaseOwner, 'other-runner');
});

test('an expired lock from a crashed runner is taken over', async () => {
  await reset(); providerMode = 'answer';
  await store.createJobRow('s6', 'j6', baseJob('s6', 'j6', { status: 'running' }), 'dead-runner', Date.now() - 1_000);
  await handler(makeReq(post('s6', 'j6')), makeRes());
  assert.equal((await rowOf('s6', 'j6')).job.status, 'completed');
});

test('a browser reconnecting at the same moment as a background hop: only one runs the task', async () => {
  await reset(); providerMode = 'loop';
  await handler(makeReq(post('s7', 'j7')), makeRes());
  await Promise.all(waited);
  const hop = nextHop();
  providerMode = 'answer'; waited.length = 0; continuationCalls.length = 0; providerCalls = 0;
  const browserRes = makeRes(), hopRes = makeRes();
  await Promise.all([
    handler(makeReq(post('s7', 'j7')), browserRes),     // the tab reconnects
    handler(makeReq(hop.body, hop.headers), hopRes),    // the server's own scheduled hop
  ]);
  await Promise.all(waited);
  assert.equal(providerCalls, 1);                        // not 2
  assert.equal((await rowOf('s7', 'j7')).job.status, 'completed');
});

test('Stop ends a running task promptly and prevents further background work', async () => {
  await reset(); providerMode = 'loop';
  const running = handler(makeReq(post('s8', 'j8')), makeRes());
  await new Promise(r => setTimeout(r, 500));
  const cancelRes = makeRes();
  await handler(makeReq({ sid: 's8', jobId: 'j8', action: 'cancel' }), cancelRes);
  assert.equal(cancelRes.state.status, 200);
  await running;
  await Promise.all(waited);
  const row = await rowOf('s8', 'j8');
  assert.equal(row.job.status, 'cancelled');
  assert.equal(row.leaseOwner, '');
  assert.equal(continuationCalls.length, 0);
});

test('Stop pressed between steps stops the next background hop from running', async () => {
  await reset(); providerMode = 'loop';
  await handler(makeReq(post('s9', 'j9')), makeRes());
  await Promise.all(waited);
  const hop = nextHop();
  await handler(makeReq({ sid: 's9', jobId: 'j9', action: 'cancel' }), makeRes());
  providerCalls = 0; waited.length = 0;
  await handler(makeReq(hop.body, hop.headers), makeRes());
  await Promise.all(waited);
  assert.equal(providerCalls, 0);
  assert.equal((await rowOf('s9', 'j9')).job.status, 'cancelled');
});

test('Stop pressed before the task row exists still prevents it from running', async () => {
  await reset(); providerMode = 'answer';
  await handler(makeReq({ sid: 's10', jobId: 'j10', action: 'cancel' }), makeRes());
  await handler(makeReq(post('s10', 'j10')), makeRes());
  assert.equal(providerCalls, 0);
  const row = await rowOf('s10', 'j10');
  assert.equal(row.job, null); assert.equal(row.cancelRequested, true);
});

test('closing the browser alone does not cancel; only the explicit signal does', async () => {
  await reset(); providerMode = 'loop';
  const req = makeReq(post('s11', 'j11')); const res = makeRes();
  const running = handler(req, res);
  await new Promise(r => setTimeout(r, 300));
  req.emit('aborted'); res.emit('close');
  await running;
  assert.equal((await rowOf('s11', 'j11')).job.status, 'paused');   // still resumable, not cancelled
  await Promise.all(waited);
  assert.equal(continuationCalls.length, 1);
});

test('chat requires a signed-in session', async () => {
  await reset();
  const req = makeReq(post('s12', 'j12')); delete req.headers.cookie;
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.state.status, 401);
  assert.equal(providerCalls, 0);
  assert.equal(await rowOf('s12', 'j12'), null);
});

test('the workspace id comes from the session, not from the request body', async () => {
  await reset(); providerMode = 'answer';
  const req = makeReq(post('mine', 'j13'));
  req.body.sid = 'someone-elses-workspace';          // a client trying to use another id
  req.headers.cookie = 'kd_session=' + signSession({ uid: 'u', sid: 'mine', username: 'tester' });
  await handler(req, makeRes());
  assert.ok(await rowOf('mine', 'j13'));
  assert.equal(await rowOf('someone-elses-workspace', 'j13'), null);
});

test('another account cannot stop or read a task by guessing its id', async () => {
  await reset(); providerMode = 'answer';
  await handler(makeReq(post('owner', 'j14')), makeRes());
  await handler(makeReq({ sid: 'intruder', jobId: 'j14', action: 'cancel' }), makeRes());
  const own = await rowOf('owner', 'j14');
  assert.equal(own.cancelRequested, false);
  assert.equal(own.job.status, 'completed');
});

test('a worker that lost its lock cannot overwrite the new owner\'s progress', async () => {
  await reset();
  await store.createJobRow('s15', 'j15', baseJob('s15', 'j15', { phase: 'executing' }), 'new-owner', Date.now() + 60_000);
  await assert.rejects(() => store.saveJobData('s15', 'j15', baseJob('s15', 'j15', { phase: 'stale' }), 'old-owner'), store.LeaseLostError);
  assert.equal((await rowOf('s15', 'j15')).job.phase, 'executing');
  assert.ok(bg.LEASE_MS >= 300_000);
});
