import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chat = fs.readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
const vision = fs.readFileSync(new URL('../api/vision.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('Gemini chat defaults to 3.6 Flash and remaps legacy 2.5 model settings', () => {
  assert.match(chat, /'gemini-3\.6-flash'/);
  assert.match(chat, /gemini-2\\\.5-\(\?:flash\|pro\)/);
});

test('Gemini vision defaults to 3.6 Flash and remaps legacy 2.5 model settings', () => {
  assert.match(vision, /'gemini-3\.6-flash'/);
  assert.match(vision, /gemini-2\\\.5-\(\?:flash\|pro\)/);
  assert.match(vision, /label: 'Genius'/);
});

test('model picker sends explicit selection and one-shot web-search state to the backend', () => {
  assert.match(html, /id="modelSelect"/);
  assert.match(html, /modelId:selectedModel,webSearch:webSearchEnabled/);
  assert.match(html, /webSearchEnabled=false;\$\('#webToggle'\)\.classList\.remove\('active'\)/);
  assert.match(html, /option value="coding">Coder/);
  assert.match(html, /option value="reasoning">Thinker/);
  assert.match(html, /option value="gemini">Genius/);
});
