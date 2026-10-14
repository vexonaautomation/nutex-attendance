import http from 'node:http';
import https from 'node:https';
import selfsigned from 'selfsigned';

/**
 * Local-testing HTTPS front for the web server, so a phone can use the camera (browsers only expose it in a secure context).
 * It serves a throw-away self-signed certificate for this machine's LAN addresses and forwards everything to the web server.
 * The phone shows a certificate warning once: choose Advanced -> Proceed. Never use this in production; use real TLS there.
 */
export async function startHttpsProxy(o: { listen: number; target: number; hosts: string[] }): Promise<https.Server> {
  const attrs = [{ name: 'commonName', value: 'nutex.local' }];
  const pems = await Promise.resolve(selfsigned.generate(attrs, {
    keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 90 * 86_400_000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...o.hosts.map((ip) => ({ type: 7 as const, ip }))] }],
  } as never));
  const { private: key, cert } = pems as unknown as { private: string; cert: string };

  const server = https.createServer({ key, cert }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: o.target, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress ?? '' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Web server is not reachable'); });
    req.pipe(up);
  });
  await new Promise<void>((resolve) => server.listen(o.listen, '0.0.0.0', resolve));
  return server;
}
