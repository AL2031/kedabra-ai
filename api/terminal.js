import { lsFiles, shell } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.json({ files: await lsFiles(req.query.sid) });
    const { sid, cmd } = req.body || {};
    res.json({ out: await shell(sid, cmd) });
  } catch (e) { res.status(500).json({ out: 'error: ' + e.message, files: [] }); }
}
