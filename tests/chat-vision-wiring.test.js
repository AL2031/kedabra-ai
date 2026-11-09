import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chat = fs.readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('chat route runs visual inspection before planning and checkpoints its text report', () => {
  assert.match(chat, /import \{ analyzeImages, validateImages \} from '\.\/vision\.js'/);
  assert.match(chat, /phase: incomingImages\.length \? 'vision'/);
  assert.match(chat, /if \(job\.phase === 'vision'\)/);
  assert.match(chat, /job\.visualContext = String\(visual\.text/);
  assert.match(chat, /VISUAL REFERENCE ANALYSIS/);
  assert.match(chat, /await checkpoint\(job\)/);
});

test('normal chat has image upload, compressed attachments, and resumable IDB storage', () => {
  assert.match(html, /id="chatFiles"/);
  assert.match(html, /id="attach"/);
  assert.match(html, /putChatImage\(/);
  assert.match(html, /getChatImage\(/);
  assert.match(html, /visionAnalyzed/);
  assert.match(html, /id="chatPreviews"/);
});
