import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isProgressOnly,
  readToolCacheKey,
  findCachedRead,
  rememberRead,
  toolMutatesWorkspace,
} from '../api/agent-guards.js';

const chat = fs.readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
const lib = fs.readFileSync(new URL('../api/_lib.js', import.meta.url), 'utf8');

test('recognizes progress narration instead of accepting it as a finished answer', () => {
  assert.equal(isProgressOnly("I'll start by inspecting the current state of the workspace files."), true);
  assert.equal(isProgressOnly('Sure, let me first review the project files.'), true);
});

test('does not classify concrete results as progress narration', () => {
  assert.equal(isProgressOnly('I inspected the project and found the issue in api/chat.js.'), false);
  assert.equal(isProgressOnly('The bug is fixed and all 14 tests passed.'), false);
  assert.equal(isProgressOnly('Here is the corrected implementation.'), false);
  assert.equal(isProgressOnly('AI news this week includes new model announcements from several labs.'), false);
});

test('rejects research progress narration and dangling research fragments', () => {
  assert.equal(isProgressOnly("I'll retry the web research now with fresh searches and direct fetches."), true);
  assert.equal(isProgressOnly("I'm searching for sources and checking the latest announcements."), true);
  assert.equal(isProgressOnly('AI news this week November 2026 OpenAI Anthropic Google DeepMind announcement November 2026'), true);
});

test('read cache is keyed by path and workspace revision', () => {
  assert.equal(readToolCacheKey('read_file', { path: 'src\\main.js' }, 3), '3:read_file:src/main.js');
  assert.equal(readToolCacheKey('read_file', { path: 'src/main.js' }, 4), '4:read_file:src/main.js');
  assert.equal(readToolCacheKey('list_files', {}, 3), '3:list_files:workspace');
  assert.equal(readToolCacheKey('terminal', { command: 'cat main.js' }, 3), '3:terminal:cat main.js');
  assert.equal(readToolCacheKey('terminal', { command: 'grep foo *.js | head' }, 3), null);
});

test('repeated reads in a step are recognized and cross-step cached content is available', () => {
  const job = { stepReadCache: [] };
  const key = readToolCacheKey('read_file', { path: 'src/main.js' }, 1);
  rememberRead(job, key, 'export const answer = 42;', 0);
  const sameStep = findCachedRead(job, key, 0);
  assert.equal(sameStep.sameStep, true);
  assert.equal(sameStep.output, 'export const answer = 42;');
  const nextStep = findCachedRead(job, key, 1);
  assert.equal(nextStep.sameStep, false);
  assert.equal(nextStep.previousStep, 0);
  assert.equal(nextStep.output, 'export const answer = 42;');
});

test('cache invalidation is triggered by workspace mutation tools, not read-only terminal commands', () => {
  assert.equal(toolMutatesWorkspace('edit_file'), true);
  assert.equal(toolMutatesWorkspace('write_files'), true);
  assert.equal(toolMutatesWorkspace('spawn_subagents'), true);
  assert.equal(toolMutatesWorkspace('terminal', { command: 'cat src/main.js' }), false);
  assert.equal(toolMutatesWorkspace('terminal', { command: 'ls -la' }), false);
  assert.equal(toolMutatesWorkspace('terminal', { command: 'npm test' }), true);
});

test('agent execution has duplicate-read protection and progress-result guardrails', () => {
  assert.match(chat, /findCachedRead\(job, readKey/);
  assert.match(chat, /isProgressOnly\(answer\)/);
  assert.match(chat, /repeatedly returned progress narration/);
  assert.match(chat, /stepReadCache/);
  assert.doesNotMatch(chat, /MAX_WEB_SEARCHES|MAX_PAGE_FETCHES/);
  assert.match(chat, /finish_reason === 'length'/);
  assert.match(chat, /PROVIDER_TIMEOUT_MS = 35_000/);
  assert.match(chat, /job.plan.steps.length === 1 && job.stepResult/);
});


test('agent execution and planning have no fixed step, round, or tool-call count limits', () => {
  assert.doesNotMatch(chat, /MAX_AGENT_ROUNDS|MAX_TOOL_CALLS_PER_STEP/);
  assert.match(chat, /for \(;;\)/);
  assert.match(chat, /There is no fixed maximum number of steps/);
  assert.doesNotMatch(chat, /data\?\.steps\.slice\(0,/);
  assert.doesNotMatch(chat, /at most \d+ for genuinely large/i);
  assert.match(chat, /maxTokens: 12_000/);
  assert.match(chat, /reaches its deadline/);
});

test('terminal and Python tools reuse cached workspace snapshots', () => {
  assert.match(lib, /export async function getWorkspaceSnapshot/);
  assert.match(lib, /snapshotCache/);
  assert.match(lib, /invalidateWorkspace/);
  assert.match(lib, /getWorkspaceSnapshot\(sid, \{ limit: 200 \}\)/);
  assert.match(chat, /getWorkspaceSnapshot\(sid/);
});
