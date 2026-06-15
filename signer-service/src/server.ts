/**
 * node:http wiring. Thin adapter: collects the raw request body, builds a
 * transport-agnostic SignerRequest, and delegates to the signer core. Only
 * used at runtime (`npm start`); tests drive `signer.handle` directly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Signer } from './signer.ts';

export function startServer(signer: Signer, port: number): Server {
  const server = createServer((req, res) => {
    void handleHttp(signer, req, res);
  });
  server.listen(port, () => {
    console.log(`[signer-service] listening on :${port}`);
  });
  return server;
}

async function handleHttp(signer: Signer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        headers[key.toLowerCase()] = value.join(',');
      }
    }

    const result = await signer.handle({
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      headers,
      rawBody,
      body,
    });
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.body));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'SIGNING_FAILED', message: 'internal signer error', retryable: false } }));
  }
}
