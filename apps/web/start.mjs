// Starts the production Next.js server on the port the platform gives us (Render, Railway, Docker: PORT), 3000 by default.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const port = process.env.PORT || '3000';
const child = spawn(process.execPath, [next, 'start', '-p', port, '-H', '0.0.0.0'], { stdio: 'inherit', cwd: import.meta.dirname });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
