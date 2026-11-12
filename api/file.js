import { readFileBytes } from './_store.js';
import { requireUser } from './_auth.js';
import { contentTypeFor, norm } from './_lib.js';

// Serves one workspace file to its owner. The workspace is taken from the signed
// session, so one account can never read another's files.
//
// Files are untrusted (a model wrote them). The headers below stop a generated HTML or
// SVG file from running scripts with access to your session if it is opened directly.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  const user = requireUser(req, res);
  if (!user) return;
  let raw = req.query?.path;
  if (raw === undefined) { try { raw = new URL(req.url || '', 'http://localhost').searchParams.get('path'); } catch { raw = ''; } }
  const path = norm(Array.isArray(raw) ? raw[0] : raw);
  if (!path) return res.status(400).json({ error: 'A file path is required.' });
  try {
    const bytes = await readFileBytes(user.sid, path);
    if (!bytes) return res.status(404).json({ error: 'No such file.' });
    res.setHeader('Content-Type', contentTypeFor(path));
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    return res.status(200).end(bytes);
  } catch (error) {
    return res.status(500).json({ error: 'Could not read the file.' });
  }
}
