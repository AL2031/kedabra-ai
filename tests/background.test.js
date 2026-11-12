import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-auth-secret';
const bg = await import('../api/_background.js');

test('continuation tokens are bound to the job and reject tampering', () => {
  const token = bg.continueToken('sid-1', 'job-1');
  assert.equal(bg.validContinueToken('sid-1', 'job-1', token), true);
  assert.equal(bg.validContinueToken('sid-1', 'job-2', token), false);
  assert.equal(bg.validContinueToken('sid-2', 'job-1', token), false);
  assert.equal(bg.validContinueToken('sid-1', 'job-1', ''), false);
  assert.equal(bg.validContinueToken('sid-1', 'job-1', 'x'.repeat(token.length)), false);
});

test('background continuation stops for finished, cancelled, failed, capped and image-less vision jobs', () => {
  assert.equal(bg.shouldContinueInBackground({ phase: 'executing', status: 'paused', hops: 1 }), true);
  assert.equal(bg.shouldContinueInBackground({ phase: 'completed', status: 'completed' }), false);
  assert.equal(bg.shouldContinueInBackground({ phase: 'executing', status: 'cancelled' }), false);
  assert.equal(bg.shouldContinueInBackground({ phase: 'executing', status: 'failed' }), false);
  assert.equal(bg.shouldContinueInBackground({ phase: 'executing', status: 'paused', hops: 5 }, 5), false);
  assert.equal(bg.shouldContinueInBackground({ phase: 'vision', status: 'paused', visualContext: '' }), false);
  assert.equal(bg.shouldContinueInBackground({ phase: 'vision', status: 'paused', visualContext: 'seen' }), true);
  assert.equal(bg.shouldContinueInBackground(null), false);
});

test('scheduleContinuation posts a signed request to this deployment via waitUntil', async () => {
  const calls = []; const waited = [];
  const ok = bg.scheduleContinuation({
    req: { headers: { host: 'app.example.com', 'x-forwarded-proto': 'https' } },
    sid: 's', jobId: 'j', delayMs: 0,
    waitUntilImpl: p => waited.push(p),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
  });
  assert.equal(ok, true);
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(calls[0].url, 'https://app.example.com/api/chat');
  assert.equal(calls[0].init.headers['x-kedabra-continue'], bg.continueToken('s', 'j'));
  assert.deepEqual(JSON.parse(calls[0].init.body), { sid: 's', jobId: 'j', background: true });
});

test('scheduleContinuation uses http for localhost and does nothing without a host', async () => {
  const calls = []; const waited = [];
  bg.scheduleContinuation({ req: { headers: { host: 'localhost:3000' } }, sid: 's', jobId: 'j', delayMs: 0, waitUntilImpl: p => waited.push(p), fetchImpl: async url => { calls.push(url); } });
  await waited[0];
  assert.equal(calls[0], 'http://localhost:3000/api/chat');
  assert.equal(bg.scheduleContinuation({ req: { headers: {} }, sid: 's', jobId: 'j', waitUntilImpl: () => {}, fetchImpl: async () => {} }), false);
});

test('BACKGROUND_MODE=off disables server-scheduled continuation', () => {
  process.env.BACKGROUND_MODE = 'off';
  try {
    const waited = [];
    assert.equal(bg.scheduleContinuation({ req: { headers: { host: 'app.example.com' } }, sid: 's', jobId: 'j', waitUntilImpl: p => waited.push(p), fetchImpl: async () => {} }), false);
    assert.equal(waited.length, 0);
  } finally { delete process.env.BACKGROUND_MODE; }
});

test('defaults: quick Stop polling (a cheap row read) and a six-hour chain cap', () => {
  assert.equal(bg.CANCEL_POLL_MS, 5_000);
  assert.equal(bg.MAX_BACKGROUND_HOPS, 120);
});
