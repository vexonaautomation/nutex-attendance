// Starts the production Next.js server on the port the platform gives us (Render, Railway, Docker: PORT), 3000 by default.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const port = process.env.PORT || '3000';
const child = spawn(process.execPath, [next, 'start', '-p', port, '-H', '0.0.0.0'], { stdio: 'inherit', cwd: import.meta.dirname });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));

// Render's free plan sleeps a service after 15 idle minutes: ping our own public URL every 2 minutes (KEEP_ALIVE=0 turns it off)
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_ALIVE !== '0') {
  setInterval(() => { fetch(`${process.env.RENDER_EXTERNAL_URL}/login`).catch(() => {}); }, 120_000).unref();
}
