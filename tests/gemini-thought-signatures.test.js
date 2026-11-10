import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  mergeProviderToolCall,
  hasGoogleThoughtSignature,
  messagesForProvider,
  isRetryableProviderStatus,
} from '../api/gemini-compat.js';

const chat = fs.readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');

test('preserves Gemini thought signatures on the original OpenAI-compatible tool call', () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } };
  mergeProviderToolCall(call, { extra_content: { google: { thought_signature: 'opaque-signature-123' } } });
  assert.equal(hasGoogleThoughtSignature(call), true);
  assert.equal(call.extra_content.google.thought_signature, 'opaque-signature-123');
  assert.equal(JSON.parse(JSON.stringify({ role: 'assistant', content: '', tool_calls: [call] })).tool_calls[0].extra_content.google.thought_signature, 'opaque-signature-123');
});

test('merges streamed metadata without losing function name or argument fragments', () => {
  const call = { id: 'call_2', type: 'function', function: { name: 'fetch_', arguments: '{"url":' } };
  mergeProviderToolCall(call, { extra_content: { google: { thought_signature: 'sig-a' }, vendor: { trace: 'trace-1' } } });
  call.function.name += 'url';
  call.function.arguments += '"https://example.com"}';
  mergeProviderToolCall(call, { extra_content: { google: { thought_signature: 'sig-a' } } });
  assert.equal(call.function.name, 'fetch_url');
  assert.equal(JSON.parse(call.function.arguments).url, 'https://example.com');
  assert.equal(call.extra_content.google.thought_signature, 'sig-a');
  assert.equal(call.extra_content.vendor.trace, 'trace-1');
});

test('preserves Google signatures for Gemini and strips only Google metadata on Groq fallback', () => {
  const messages = [{ role: 'assistant', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig-b' }, other: { keep: true } } }] }];
  const forGoogle = messagesForProvider(messages, 'google');
  const forGroq = messagesForProvider(messages, 'groq');
  assert.equal(forGoogle[0].tool_calls[0].extra_content.google.thought_signature, 'sig-b');
  assert.equal(forGroq[0].tool_calls[0].extra_content.google, undefined);
  assert.equal(forGroq[0].tool_calls[0].extra_content.other.keep, true);
  assert.equal(messages[0].tool_calls[0].extra_content.google.thought_signature, 'sig-b');
});

test('classifies invalid provider requests as non-retryable and transient failures as retryable', () => {
  assert.equal(isRetryableProviderStatus(400), false);
  assert.equal(isRetryableProviderStatus(401), false);
  assert.equal(isRetryableProviderStatus(429), true);
  assert.equal(isRetryableProviderStatus(503), true);
});

test('Gemini stream parser retains thought signatures and refuses to execute unsigned tool calls', () => {
  assert.match(chat, /mergeProviderToolCall\(call, tool\)/);
  assert.match(chat, /hasGoogleThoughtSignature\(msg\.tool_calls\[0\]\)/);
  assert.match(chat, /messagesForProvider\(messages, provider\.provider\)/);
  assert.match(chat, /isRetryableProviderStatus\(status\)/);
  assert.match(chat, /if \(permanentError && !retryableErrorSeen\) throw permanentError/);
});


test('stream parser attaches a signature delivered in a later tool-call chunk', async () => {
  const start = chat.indexOf('async function readStream(response, onText) {');
  const end = chat.indexOf('\n}\n\nasync function llm', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const readStreamSource = chat.slice(start, end + 2).replace('async function readStream', 'async function');
  const readStream = vm.runInNewContext(`(${readStreamSource})`, {
    mergeProviderToolCall,
    TextDecoder,
  });

  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'web_search', arguments: '{\"query\":\"AI news\"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'streamed-signature' } } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const sse = [...events.map(event => `data: ${JSON.stringify(event)}`), 'data: [DONE]', ''].join('\n');
  const result = await readStream(new Response(sse));
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].function.name, 'web_search');
  assert.equal(result.tool_calls[0].extra_content.google.thought_signature, 'streamed-signature');
});
