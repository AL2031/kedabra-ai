// Server-side background execution helpers.
//
// A task only advances while something keeps invoking it. Each serverless invocation
// that ends with work left schedules the next one itself, so a task keeps running after
// the tab is closed or the computer is switched off. The lock that keeps two workers off
// the same task, and the Stop flag, live in the database (see _store.js).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { isJobCancelRequested } from './_store.js';
import { appSecret } from './_secret.js';

// A lease outlives one invocation (maxDuration is 300 s). It is cleared when an
// invocation ends cleanly and simply expires if one crashes.
export const LEASE_MS = 300_000;
// Safety net against a runaway chain (about 6 hours at ~3 minutes per hop).
export const MAX_BACKGROUND_HOPS = Number(process.env.MAX_BACKGROUND_INVOCATIONS) || 120;
// How often a running invocation looks for a Stop signal (one cheap row read).
export const CANCEL_POLL_MS = Number(process.env.CANCEL_POLL_MS) || 5_000;

// Indirection so tests can capture background work without a Vercel runtime.
export const runtime = { waitUntil: promise => vercelWaitUntil(promise) };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value || '').replace(/[^\w-]/g, '');
const secret = () => process.env.KEDABRA_CONTINUE_SECRET || appSecret('continue');

// ---- Authenticating the server-to-server continuation request -------------
export const continueToken = (sid, jobId) =>
  createHmac('sha256', secret()).update(`${clean(sid)}:${clean(jobId)}`).digest('hex');

export function validContinueToken(sid, jobId, token) {
  if (!secret() || !token) return false;
  const expected = Buffer.from(continueToken(sid, jobId));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Polls the Stop flag so the synchronous dead() checks inside the agent loop can see it.
// Returns a function that stops the watcher.
export function startCancelWatcher(sid, jobId, onCancel, intervalMs = CANCEL_POLL_MS) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try { if (await isJobCancelRequested(sid, jobId)) { onCancel(); stopped = true; clearInterval(timer); } } catch { /* transient; try again */ }
  }, intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

// ---- Deciding whether to keep going without a browser ------------------------
export function shouldContinueInBackground(job, maxHops = MAX_BACKGROUND_HOPS) {
  if (!job) return false;
  if (job.phase === 'completed' || ['completed', 'cancelled', 'failed'].includes(job.status)) return false;
  // Image bytes live only in the browser; without them this phase cannot continue.
  if (job.phase === 'vision' && !job.visualContext) return false;
  return (job.hops || 0) < maxHops;
}

// Schedules the next invocation of /api/chat for this job. The request is signed with an
// HMAC so only this server can start background work.
export function scheduleContinuation({ req, sid, jobId, delayMs = Number(process.env.BACKGROUND_HOP_DELAY_MS ?? 8_000), waitUntilImpl = promise => runtime.waitUntil(promise), fetchImpl = globalThis.fetch }) {
  if (process.env.BACKGROUND_MODE === 'off') return false; // kill switch: tasks then advance only while a browser is attached
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (!host || !secret()) return false;
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = local ? 'http' : String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const headers = { 'content-type': 'application/json', 'x-kedabra-continue': continueToken(sid, jobId) };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  // The short delay lets a still-open browser tab reconnect first and keep the live
  // stream; if it does, this hop finds the lease taken and exits at once.
  const task = (async () => {
    await sleep(delayMs);
    try { await fetchImpl(`${proto}://${host}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ sid, jobId, background: true }) }); } catch { /* the browser or a later hop will pick the job up */ }
  })();
  waitUntilImpl(task);
  return true;
}
