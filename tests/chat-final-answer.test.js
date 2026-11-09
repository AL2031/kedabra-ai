import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function ev(e,a){');
assert.notEqual(start, -1, 'event handler exists');
const end = html.indexOf('\n}', start);
assert.notEqual(end, -1, 'event handler has a closing brace');
const source = html.slice(start, end + 2);
const ev = vm.runInNewContext(`(${source})`);

test('renders a final answer when the backend sends done without streamed deltas', () => {
  const message = { parts: [] };
  ev({ t: 'done', answer: 'Hello! How can I help?' }, message);
  assert.equal(message.done, true);
  assert.equal(message.content, 'Hello! How can I help?');
  assert.deepEqual(message.parts.map(part => part.type), ['text']);
  assert.equal(message.parts[0].text, 'Hello! How can I help?');
});

test('does not duplicate an answer that was already streamed', () => {
  const message = { parts: [{ type: 'text', text: 'Hello', live: true }] };
  ev({ t: 'done', answer: 'Hello' }, message);
  assert.equal(message.parts.filter(part => part.type === 'text').length, 1);
  assert.equal(message.parts[0].live, false);
  assert.equal(message.parts[0].text, 'Hello');
});

test('uses the backend final answer if it differs from the streamed preview', () => {
  const message = { parts: [
    { type: 'status', status: 'Preparing final response' },
    { type: 'text', text: 'Partial answer', live: true },
  ] };
  ev({ t: 'done', answer: 'The complete final answer.' }, message);
  const visible = message.parts.filter(part => part.type === 'text');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].text, 'The complete final answer.');
  assert.equal(visible[0].live, false);
  assert.equal(message.content, 'The complete final answer.');
});
