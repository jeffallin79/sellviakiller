// Production entry for the storefront (`pnpm start`): Next's request handler behind a tiny HTTP
// server that stamps each request with the real TCP peer, so the middleware can decide whether
// to trust X-Forwarded-Host (TRUSTED_PROXIES). See src/lib/trusted-proxy.ts.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import next from 'next';

process.env.SF_PEER_TOKEN = randomBytes(24).toString('hex'); // per boot; never configurable
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME_BIND ?? '0.0.0.0';
const app = next({ dev: false, dir: new URL('.', import.meta.url).pathname });
const handle = app.getRequestHandler();
await app.prepare();
createServer((req, res) => {
  const peer = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  req.headers['x-sf-peer'] = `${peer};${process.env.SF_PEER_TOKEN}`; // overwrites anything the client sent
  handle(req, res);
}).listen(port, hostname, () => console.log(`storefront ready on http://${hostname}:${port}`));
