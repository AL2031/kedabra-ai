// Username + password accounts. No email. Users live in the database (see _store.js).
//
// Security model:
// - Passwords are hashed with scrypt and a per-user random salt. Plain passwords are never stored.
// - Sessions are signed (HMAC) cookies: HttpOnly, SameSite=Lax, Secure on https.
// - The server derives the workspace id (`sid`) from the session, so a client cannot read
//   another account's workspace by sending a different id.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getUser, insertUser, updateUserAuth, recordLoginFailure } from './_store.js';
import { rootSecret, appSecret } from './_secret.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

export const SESSION_COOKIE = 'kd_session';
export const USER_COOKIE = 'kd_user'; // readable by page script; holds only the username
export const SESSION_DAYS = 30;
export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60_000;
export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

// ---- Secrets ---------------------------------------------------------------------
export const authConfigured = () => Boolean(rootSecret());
const mac = (label, value, encoding = 'hex') => createHmac('sha256', appSecret('auth')).update(`${label}:${value}`).digest(encoding);

// ---- Validation ----------------------------------------------------------------------
export const normalizeUsername = value => String(value ?? '').trim().toLowerCase();

export function validateUsername(username) {
  if (!USERNAME_RE.test(username)) return 'Usernames are 3-32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.';
  return '';
}
export function validatePassword(password) {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < 8) return 'Passwords must be at least 8 characters.';
  if (password.length > 200) return 'Passwords can be at most 200 characters.';
  return '';
}

// ---- Password hashing ------------------------------------------------------------------
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  if (!expected.length || ![N, r, p].every(n => Number.isInteger(+n) && +n > 0)) return false;
  const key = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummyHash;
const getDummyHash = () => (dummyHash ||= hashPassword('kedabra-timing-equalizer'));

// ---- Sessions ------------------------------------------------------------------------------
export function signSession({ uid, sid, username }, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ uid, sid, u: username, exp: now + SESSION_DAYS * 86_400_000 })).toString('base64url');
  return `${payload}.${mac('session', payload, 'base64url')}`;
}

export function verifySession(token, now = Date.now()) {
  if (!authConfigured() || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(mac('session', parts[0], 'base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!data || !data.uid || !data.sid || !(data.exp > now)) return null;
  return { uid: String(data.uid), sid: String(data.sid), username: String(data.u || '') };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!(name in out)) out[name] = part.slice(index + 1).trim();
  }
  return out;
}

const hostOf = req => String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
const isLocal = req => /^(localhost|127\.|\[::1\])/.test(hostOf(req));

export function sessionCookies(req, token, username) {
  const attrs = `Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${isLocal(req) ? '' : '; Secure'}`;
  return [`${SESSION_COOKIE}=${token}; HttpOnly; ${attrs}`, `${USER_COOKIE}=${encodeURIComponent(username)}; ${attrs}`];
}

export function clearCookies(req) {
  const attrs = `Path=/; SameSite=Lax; Max-Age=0${isLocal(req) ? '' : '; Secure'}`;
  return [`${SESSION_COOKIE}=; HttpOnly; ${attrs}`, `${USER_COOKIE}=; ${attrs}`];
}

export const getSession = req => verifySession(parseCookies(req?.headers?.cookie)[SESSION_COOKIE]);

// Browsers attach Origin to cross-site POSTs. Requests with no Origin (curl, server
// to server) are allowed here, but they still need a valid session cookie.
export function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === hostOf(req); } catch { return false; }
}

// Returns the signed-in user, or answers 401/403 itself and returns null.
export function requireUser(req, res) {
  if (req.method !== 'GET' && !sameOrigin(req)) { res.status(403).json({ error: 'Cross-site request blocked.' }); return null; }
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: 'Please sign in.', login: true }); return null; }
  return session;
}

// ---- User store ---------------------------------------------------------------------------------
export const loadUser = getUser;

// The database enforces unique usernames, so two simultaneous signups cannot both win.
export async function createUser({ username, password }) {
  const id = randomBytes(18).toString('hex');
  const user = { id, username, sid: id, hash: await hashPassword(password), createdAt: Date.now(), failCount: 0, lockedUntil: 0 };
  if (!(await insertUser(user))) return { error: 'taken' };
  return { user };
}

// Verifies credentials with per-account lockout. Unknown usernames take the same
// time as wrong passwords so response timing does not reveal which usernames exist.
export async function authenticate(username, password, now = Date.now()) {
  const invalid = { ok: false, status: 401, error: 'Invalid username or password.' };
  const user = await loadUser(username);
  if (!user) { await verifyPassword(password, await getDummyHash()); return invalid; }
  if (user.lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil - now) / 60_000));
    return { ok: false, status: 429, error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
  }
  if (!(await verifyPassword(password, user.hash))) {
    await recordLoginFailure(user.username, MAX_FAILS, LOCK_MS, now);
    return invalid;
  }
  if (user.failCount || user.lockedUntil) { user.failCount = 0; user.lockedUntil = 0; await updateUserAuth(user); }
  return { ok: true, user };
}

// Admin recovery (there is no email reset). Used by scripts/auth-admin.mjs.
export async function setPassword(username, newPassword) {
  const problem = validatePassword(newPassword);
  if (problem) throw new Error(problem);
  const user = await loadUser(normalizeUsername(username));
  if (!user) return false;
  user.hash = await hashPassword(newPassword);
  user.failCount = 0;
  user.lockedUntil = 0;
  await updateUserAuth(user);
  return true;
}

// ---- Optional invite code to keep strangers from signing up ----------------------------------
export const signupCodeRequired = () => Boolean(process.env.SIGNUP_CODE);
export function signupCodeMatches(code) {
  const wanted = createHmac('sha256', 'invite').update(String(process.env.SIGNUP_CODE || '')).digest();
  const given = createHmac('sha256', 'invite').update(String(code ?? '')).digest();
  return timingSafeEqual(wanted, given);
}
