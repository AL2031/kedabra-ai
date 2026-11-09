// Runs Python (Pyodide) in an isolated child process with NO secrets in its environment.
import { loadPyodide } from 'pyodide';
let inp = ''; for await (const c of process.stdin) inp += c;
const { code, files } = JSON.parse(inp);
const out = [];
const py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/', stdout: t => out.push(t), stderr: t => out.push(t) });
py.FS.mkdirTree('/work');
for (const [p, c] of Object.entries(files)) { py.FS.mkdirTree(('/work/' + p).replace(/\/[^/]*$/, '')); py.FS.writeFile('/work/' + p, c); }
py.FS.chdir('/work');
let error;
try { await py.loadPackagesFromImports(code); await py.runPythonAsync(code); }
catch (e) { error = String(e.message || e).split('\n').slice(-12).join('\n'); }
const changed = {}, dec = new TextDecoder('utf-8', { fatal: true });
(function walk(d) {
  for (const n of py.FS.readdir(d)) {
    if (n === '.' || n === '..' || n === '__pycache__') continue;
    const f = d + '/' + n, st = py.FS.stat(f);
    if (py.FS.isDir(st.mode)) { walk(f); continue; }
    const rel = f.slice(6), b = py.FS.readFile(f);
    if (b.length > 2e6) continue;
    try { const t = dec.decode(b); if (files[rel] !== t) changed[rel] = t; } catch { changed[rel] = { b64: Buffer.from(b).toString('base64') }; }
  }
})('/work');
process.stdout.write('\n@@RESULT@@' + JSON.stringify({ out: out.join('\n'), error, changed }));
process.exit(0);
