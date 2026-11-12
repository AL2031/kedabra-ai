import {
  authConfigured, normalizeUsername, validateUsername, validatePassword, createUser, authenticate,
  signSession, sessionCookies, clearCookies, getSession, sameOrigin, signupCodeRequired, signupCodeMatches,
} from './_auth.js';
import { storeConfigured } from './_store.js';

// GET  -> { user, signupCodeRequired }     (also refreshes the session cookie)
// POST -> { action: 'signup' | 'login' | 'logout', ... }
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!storeConfigured()) return res.status(500).json({ error: 'The database is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.' });
    if (!authConfigured()) return res.status(500).json({ error: 'Accounts need a signing key. Set AUTH_SECRET (or TURSO_AUTH_TOKEN).' });

    if (req.method === 'GET') {
      const session = getSession(req);
      if (!session) {
        res.setHeader('Set-Cookie', clearCookies(req));
        return res.status(200).json({ user: null, signupCodeRequired: signupCodeRequired() });
      }
      res.setHeader('Set-Cookie', sessionCookies(req, signSession(session), session.username)); // rolling session
      return res.status(200).json({ user: { username: session.username } });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-site request blocked.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '');

    if (action === 'logout') {
      res.setHeader('Set-Cookie', clearCookies(req));
      return res.status(200).json({ ok: true });
    }

    const username = normalizeUsername(body.username);
    const password = body.password;
    const problem = validateUsername(username) || validatePassword(password);

    if (action === 'signup') {
      if (problem) return res.status(400).json({ error: problem });
      if (signupCodeRequired() && !signupCodeMatches(body.inviteCode)) return res.status(403).json({ error: 'That invite code is not valid.' });
      const created = await createUser({ username, password });
      if (created.error === 'taken') return res.status(409).json({ error: 'That username is taken.' });
      res.setHeader('Set-Cookie', sessionCookies(req, signSession({ uid: created.user.id, sid: created.user.sid, username }), username));
      return res.status(200).json({ user: { username } });
    }

    if (action === 'login') {
      // Do not reveal whether the username format was the problem.
      if (typeof password !== 'string' || !username || password.length > 200) return res.status(401).json({ error: 'Invalid username or password.' });
      const result = await authenticate(username, password);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.setHeader('Set-Cookie', sessionCookies(req, signSession({ uid: result.user.id, sid: result.user.sid, username: result.user.username }), result.user.username));
      return res.status(200).json({ user: { username: result.user.username } });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (error) {
    console.error('auth error:', error?.message || error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
