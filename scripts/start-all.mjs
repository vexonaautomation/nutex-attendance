// One service runs everything: the website on the public PORT and the API next to it on 127.0.0.1 (never exposed).
// The website forwards /api/* to the API (apps/web/proxy.ts). Used by the Docker image; `start:api` / `start:web` still work alone.
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const apiPort = process.env.API_PORT || '4000';

const children = [];
const run = (dir, args, env) => {
  const child = spawn(process.execPath, args, { cwd: path.join(root, dir), stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => stop(code ?? 1));
  children.push(child);
};

// if either one stops, stop the whole service so the platform restarts both
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  process.exitCode = code;
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));

run('apps/api', ['--import', 'tsx', 'src/main.ts'], { PORT: apiPort, HOST: '127.0.0.1' });

// the website opens its port only once the API answers, so nobody gets an error while the service is starting
const api = `http://127.0.0.1:${apiPort}`;
while (!stopping) {
  try { if ((await fetch(`${api}/api/health`)).ok) break; } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!stopping) run('apps/web', ['start.mjs'], { API_URL: api });
