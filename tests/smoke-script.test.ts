import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

function runSmoke(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/smoke.mjs', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Phase 24 smoke script', () => {
  it('checks healthz, version, and webhook secret enforcement without mutating Telegram', async () => {
    const seenRequests: Array<{ method?: string; url?: string; secret?: string }> = [];
    const server = createServer((request, response) => {
      seenRequests.push({
        method: request.method,
        url: request.url,
        secret: request.headers['x-telegram-bot-api-secret-token'] as string | undefined,
      });

      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          version: '0.6.0',
          readiness: {
            live_order_api: true,
            signing: true,
            builder_attribution: 'ready',
            live_trading_allowlist: true,
            warnings: [],
          },
        }));
        return;
      }

      if (request.method === 'GET' && request.url === '/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ version: '0.6.0' }));
        return;
      }

      if (request.method === 'POST' && request.url === '/telegram/webhook/crypto_zh') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('Unauthorized');
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP test server address');
    }

    try {
      const result = await runSmoke([`http://127.0.0.1:${address.port}`]);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'healthz', ok: true }),
        expect.objectContaining({ name: 'version', ok: true }),
        expect.objectContaining({ name: 'webhook_secret_enforced', ok: true }),
      ]));
      expect(payload.checks.find((check) => check.name === 'healthz')?.detail).toContain('live allowlist enabled');
      expect(seenRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', url: '/healthz' }),
        expect.objectContaining({ method: 'GET', url: '/version' }),
        expect.objectContaining({ method: 'POST', url: '/telegram/webhook/crypto_zh', secret: 'newbot-smoke-invalid-secret' }),
      ]));
    } finally {
      server.close();
    }
  });

  it('can fail a rollout smoke when strict readiness has blockers', async () => {
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          version: '0.6.0',
          readiness: {
            live_order_api: true,
            signing: false,
            builder_attribution: 'partial',
            live_trading_allowlist: false,
            warnings: ['signing secret 还没配置。'],
          },
        }));
        return;
      }

      if (request.method === 'GET' && request.url === '/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ version: '0.6.0' }));
        return;
      }

      if (request.method === 'POST' && request.url === '/telegram/webhook/crypto_zh') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('Unauthorized');
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP test server address');
    }

    try {
      const result = await runSmoke(['--require-ready', `http://127.0.0.1:${address.port}`]);

      expect(result.stdout).toBe('');
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stderr) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'rollout_readiness', ok: false }),
      ]));
      expect(payload.checks.find((check) => check.name === 'rollout_readiness')?.detail).toContain('signing secret');
    } finally {
      server.close();
    }
  });

  it('can post a structured smoke report to an authenticated report endpoint', async () => {
    let receivedReport: unknown = null;
    let receivedSecret: string | undefined;
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          version: '0.6.0',
          readiness: {
            live_order_api: true,
            signing: true,
            builder_attribution: 'ready',
            live_trading_allowlist: true,
            warnings: [],
          },
        }));
        return;
      }

      if (request.method === 'GET' && request.url === '/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ version: '0.6.0' }));
        return;
      }

      if (request.method === 'POST' && request.url === '/telegram/webhook/crypto_zh') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('Unauthorized');
        return;
      }

      if (request.method === 'POST' && request.url === '/ops/smoke-report') {
        receivedSecret = request.headers['x-newbot-smoke-report-secret'] as string | undefined;
        let body = '';
        request.on('data', (chunk) => {
          body += String(chunk);
        });
        request.on('end', () => {
          receivedReport = JSON.parse(body);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, stored: true }));
        });
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP test server address');
    }

    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const result = await runSmoke([
        baseUrl,
        '--report-url', `${baseUrl}/ops/smoke-report`,
        '--report-secret', 'report-secret',
      ]);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(receivedSecret).toBe('report-secret');
      expect(receivedReport).toMatchObject({
        ok: true,
        target: baseUrl,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'healthz', ok: true }),
        ]),
      });
    } finally {
      server.close();
    }
  });
});
