import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chat = fs.readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('agent execution has no fixed step, round, or per-step tool-call ceiling', () => {
  assert.match(chat, /async function agentLoop\(conversation, options\) \{/);
  assert.match(chat, /for \(;;\) \{[\s\S]*?No fixed agent-round or tool-call count/);
  assert.doesNotMatch(chat, /MAX_AGENT_ROUNDS|MAX_TOOL_CALLS|MAX_STEPS|MAX_EXECUTION_STEPS/);
  assert.doesNotMatch(chat, /stepToolCalls\s*>=\s*\d+/);
  assert.doesNotMatch(chat, /steps\s*=\s*steps\.slice\(0,\s*\d+\)/);
});

test('research tools have no fixed search-count or page-fetch-count ceiling', () => {
  assert.doesNotMatch(chat, /MAX_WEB_SEARCHES|MAX_PAGE_FETCHES/);
  assert.doesNotMatch(chat, /webSearchCount\s*\|\|\s*0\)\s*>=/);
  assert.doesNotMatch(chat, /webFetchCount\s*\|\|\s*0\)\s*>=/);
  assert.match(chat, /there is no fixed search or page-count ceiling/i);
});

test('larger plans receive a larger output allowance and are not sliced to eight steps', () => {
  assert.match(chat, /maxTokens: 12_000/);
  assert.match(chat, /const steps = Array\.isArray\(data\?\.steps\) \? data\.steps\.map/);
  assert.doesNotMatch(chat, /data\?\.steps\)\.slice\(0,\s*8\)/);
});

test('UI exposes the three friendly model names and uses a more compact scale', () => {
  assert.match(html, /option value="coding">Coder/);
  assert.match(html, /option value="reasoning">Thinker/);
  assert.match(html, /option value="gemini">Genius/);
  assert.match(html, /Compact density pass/);
  assert.match(html, /width:clamp\(270px,19\.2vw,360px\)/);
  assert.match(html, /height:130px;min-height:130px/);
});

test('README documents model mapping and unlimited task-step execution accurately', () => {
  assert.match(readme, /\*\*Coder\*\*/);
  assert.match(readme, /\*\*Thinker\*\*/);
  assert.match(readme, /\*\*Genius\*\*/);
  assert.match(readme, /no fixed task-step count/i);
  assert.doesNotMatch(readme, /Distinct web searches and page fetches are capped/);
});
