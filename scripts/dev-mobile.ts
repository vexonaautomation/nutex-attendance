/**
 * Run NUTEX so a phone on the same Wi-Fi can open it.
 *
 *   npm run dev:mobile              builds the web app if needed, starts the emulator API + the production web server,
 *                                   and prints the URL to open on the phone
 *   npm run dev:mobile -- --rebuild force a rebuild first
 *   npm run dev:live                the same, but on YOUR real Google Sheet (settings from .env, your own logins, no demo data)
 *
 * Only port 3000 needs to be reachable: the web server proxies /api to the API on localhost, so the API is never exposed.
 *
 * Location check-in needs a secure context, so the script also serves https://<lan-ip>:3443 with a throw-away self-signed
 * certificate (accept the warning once on the phone). Plain http://<lan-ip>:3000 works for everything except location. Alternatives:
 *   - Android Chrome: open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add the printed URL, enable, relaunch; or
 *   - any phone: use an HTTPS tunnel, for example `cloudflared tunnel --url http://localhost:3000` (this makes the demo
 *     reachable from the internet; it holds only synthetic demo data, but treat the URL as public).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { ROOT } from './lib/env';
import { startHttpsProxy } from './lib/https-proxy';

const web = path.join(ROOT, 'apps', 'web');

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/vethernet|wsl|virtual|vmware|vbox|docker|loopback|bluetooth/i.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args: string[], env: Record<string, string> = {}): ChildProcess =>
  spawn(npm, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });

async function waitFor(url: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${url} did not come up in time`);
}

const live = process.argv.includes('--live');

async function main() {
  if (process.argv.includes('--rebuild') || !existsSync(path.join(web, '.next', 'BUILD_ID'))) {
    console.log('Building the web app (first run takes a minute)...');
    const b = spawnSync(npm, ['run', 'build', '-w', '@nutex/web'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (b.status !== 0) process.exit(b.status ?? 1);
  }
  const children: ChildProcess[] = [];
  const stop = () => { for (const c of children) c.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // NODE_ENV stays non-production on purpose: the emulator backend refuses to run in production
  children.push(run(['run', live ? 'start' : 'dev', '-w', '@nutex/api'], { HOST: '0.0.0.0' }));
  await waitFor('http://127.0.0.1:4000/api/health');
  children.push(run(['run', 'start', '-w', '@nutex/web'], { API_URL: 'http://127.0.0.1:4000' }));
  await waitFor('http://localhost:3000/login');

  const ips = lanAddresses();
  // secure context for the phone location (check-in / check-out): self-signed HTTPS in front of the web server
  let httpsOk = false;
  try { await startHttpsProxy({ listen: 3443, target: 3000, hosts: ips }); httpsOk = true; } catch (e) { console.warn(`HTTPS front could not start: ${e instanceof Error ? e.message : e}`); }
  console.log('\n==============================================================');
  console.log(live ? ' NUTEX is running on your REAL Google Sheet (settings from .env)' : ' NUTEX is running (emulator backend, synthetic demo data)');
  console.log('--------------------------------------------------------------');
  if (!ips.length) console.log(' No LAN address found. Connect this PC to the same Wi-Fi / network as the phone.');
  for (const ip of ips) {
    if (httpsOk) console.log(`  On your phone open:  https://${ip}:3443   <- use this one (location works)`);
    console.log(`  Without location:    http://${ip}:3000`);
  }
  if (httpsOk) {
    console.log('\n  First visit shows a certificate warning (self-signed, local only):');
    console.log('  Advanced -> Proceed / Visit this website. Then check-in can read the phone location.');
  }
  console.log(live ? '\n  Login:               the administrator created by npm run google:init' : '\n  Login:               admin / 123  (local test mode; other accounts: .local/seed-credentials.txt)');
  console.log('  Stop:                Ctrl+C');
  console.log('\n  If the phone cannot connect: allow Node.js through Windows Firewall');
  console.log('  (Private networks), and make sure the phone is on the same Wi-Fi.');
  console.log('==============================================================\n');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
