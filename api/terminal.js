import { lsFiles, shell } from './_lib.js';
import { requireUser } from './_auth.js';

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  // The workspace id always comes from the session, not from the request.
  const sid = user.sid;
  try {
    if (req.method === 'GET') return res.json({ files: await lsFiles(sid) });
    const { cmd } = req.body || {};
    res.json({ out: await shell(sid, cmd) });
  } catch (e) { res.status(500).json({ out: 'error: ' + e.message, files: [] }); }
}
