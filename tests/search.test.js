import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { useTempDb, clearTables } from './helpers/db.js';

useTempDb();
const bgModule = await import('../api/_background.js');
bgModule.runtime.waitUntil = () => {};
process.env.GROQ_API_KEY_1 = 'test-groq-key';
delete process.env.TAVILY_API_KEY;

// ---- Fake network: DuckDuckGo, Tavily and the model provider ---------------------------------------------
let ddg = { status: 200, delayMs: 0, throwError: null, html: '' };
let tavily = { status: 200 };
let ddgCalls = 0, inFlight = 0, maxInFlight = 0, providerCalls = 0;
const resultsPage = (...titles) => titles.map((t, i) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/' + i)}">${t}</a><a class="result__snippet">snippet ${i}</a>`).join('\n');
const sse = parts => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const p of parts) c.enqueue(e.encode('data: ' + (typeof p === 'string' ? p : JSON.stringify(p)) + '\n\n')); c.close(); } }), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes('duckduckgo.com')) {
    ddgCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (ddg.delayMs) await new Promise(r => setTimeout(r, ddg.delayMs));
      if (ddg.throwError) throw ddg.throwError;
      return new Response(ddg.html, { status: ddg.status });
    } finally { inFlight--; }
  }
  if (url.includes('api.tavily.com')) return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t.example/', content: 'c' }] }), { status: tavily.status });
  if (url.includes('groq.com')) {
    providerCalls++;
    if (providerCalls === 1) {
      const call = (index, query) => ({ index, id: 'call_' + index, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } });
      return sse([{ choices: [{ delta: { tool_calls: [call(0, 'cats'), call(1, 'dogs'), call(2, 'birds')] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
    }
    return sse([{ choices: [{ delta: { content: 'Here is what I found.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  }
  return realFetch(url, init);
};

const chat = await import('../api/chat.js');
const store = await import('../api/_store.js');
const { signSession } = await import('../api/_auth.js');
beforeEach(async () => { await clearTables(); ddg = { status: 200, delayMs: 0, throwError: null, html: resultsPage('One', 'Two') }; tavily = { status: 200 }; ddgCalls = 0; inFlight = 0; maxInFlight = 0; providerCalls = 0; delete process.env.TAVILY_API_KEY; });

const ctx = job => ({ sid: 's', send() {}, tid: 't', job, deadline: Date.now() + 60_000, dead: () => false, modelId: 'coding' });

test('a successful search returns titles, urls and snippets', async () => {
  const results = await chat.search('cats');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { title: 'One', url: 'https://example.com/0', snippet: 'snippet 0' });
});

test('DuckDuckGo soft-blocking (HTTP 202) is reported as an outage, not as "no results"', async () => {
  ddg.status = 202; ddg.html = '<html>home</html>';
  await assert.rejects(() => chat.search('cats'), chat.SearchUnavailable);
});

test('a genuine empty result is just "no results" and does not trip the outage breaker', async () => {
  ddg.html = '<html><body>No results.</body></html>';
  const job = {};
  const out = await chat.runTool('web_search', { query: 'asdkjhasd' }, ctx(job));
  assert.match(out, /No results found/);
  assert.equal(job.searchDownUntil, undefined);
});

test('after one outage, later searches in the task fail instantly instead of waiting again', async () => {
  ddg.status = 202;
  const job = {};
  const first = await chat.runTool('web_search', { query: 'one' }, ctx(job));
  assert.match(first.error, /temporarily unavailable/);
  assert.match(first.error, /rate limiting/);
  assert.equal(ddgCalls, 1);
  const t0 = Date.now();
  const second = await chat.runTool('web_search', { query: 'two' }, ctx(job));
  const third = await chat.runTool('web_search', { query: 'three' }, ctx(job));
  assert.match(second.error, /Do not retry/); assert.match(third.error, /Do not retry/);
  assert.equal(ddgCalls, 1);                                  // no further network attempts
  assert.ok(Date.now() - t0 < 100);
});

test('a timeout counts as an outage too', async () => {
  ddg.throwError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const job = {};
  const out = await chat.runTool('web_search', { query: 'slow' }, ctx(job));
  assert.match(out.error, /temporarily unavailable/);
  assert.ok(job.searchDownUntil > Date.now());
});

test('the outage window ends, so search is tried again later', async () => {
  ddg.status = 202;
  const job = {};
  await chat.runTool('web_search', { query: 'x' }, ctx(job));
  job.searchDownUntil = Date.now() - 1;                       // window elapsed
  ddg.status = 200;
  const again = await chat.runTool('web_search', { query: 'y' }, ctx(job));
  assert.equal(again.length, 2);
});

test('there is still no fixed ceiling on the number of searches in a task', async () => {
  const job = { webSearchCount: 500 };
  const out = await chat.runTool('web_search', { query: 'search number 501' }, ctx(job));
  assert.equal(out.length, 2);
  assert.equal(job.webSearchCount, 501);
});

test('repeating a query reuses the saved result and costs nothing', async () => {
  const job = {};
  await chat.runTool('web_search', { query: 'Cats  ' }, ctx(job));
  const again = await chat.runTool('web_search', { query: 'cats' }, ctx(job));
  assert.equal(again.cached, true);
  assert.equal(ddgCalls, 1);
});

test('Tavily rate limiting is treated as an outage', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test'; tavily.status = 429;
  const out = await chat.runTool('web_search', { query: 'cats' }, ctx({}));
  assert.match(out.error, /temporarily unavailable/);
  tavily.status = 200;
  assert.equal((await chat.runTool('web_search', { query: 'dogs' }, ctx({})))[0].title, 'T');
});

test('several searches in one model turn run at the same time, not one after another', async () => {
  ddg.delayMs = 150;
  const sid = 'par';
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', headers: { host: 'app.example.com', cookie: 'kd_session=' + signSession({ uid: 'u', sid, username: 't' }) },
    body: { sid, jobId: 'jpar', messages: [{ role: 'user', content: 'Say hello' }], modelId: 'auto' } });
  const res = new EventEmitter();
  Object.assign(res, { writableEnded: false, setHeader() {}, flushHeaders() {}, status() { return res; }, json() { res.writableEnded = true; return res; }, write() { return true; }, end() { res.writableEnded = true; return res; } });
  await chat.default(req, res);
  const { job } = await store.getJobRow(sid, 'jpar');
  assert.equal(job.status, 'completed');
  assert.equal(job.webSearchCount, 3);
  assert.equal(maxInFlight, 3);                               // all three were in flight together
  assert.equal(ddgCalls, 3);
});
