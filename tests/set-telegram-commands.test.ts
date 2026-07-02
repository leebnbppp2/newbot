import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations.
import { PUBLIC_COMMANDS, OPERATOR_COMMANDS, validateCommands, PERSONA_TOKEN_ENV } from '../scripts/set-telegram-commands.mjs';

interface Cmd {
  command: string;
  description: string;
}

function runScript(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/set-telegram-commands.mjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
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

describe('telegram command catalog', () => {
  it('every command name obeys the Bot API rule and descriptions fit', () => {
    expect(validateCommands(PUBLIC_COMMANDS as Cmd[])).toEqual([]);
    expect(validateCommands([...PUBLIC_COMMANDS, ...OPERATOR_COMMANDS] as Cmd[])).toEqual([]);
    expect((PUBLIC_COMMANDS as Cmd[]).length).toBeGreaterThan(0);
  });

  it('public and operator command sets are disjoint', () => {
    const publicNames = new Set((PUBLIC_COMMANDS as Cmd[]).map((c) => c.command));
    const overlap = (OPERATOR_COMMANDS as Cmd[]).filter((c) => publicNames.has(c.command));
    expect(overlap).toEqual([]);
  });

  it('catches an invalid command name', () => {
    expect(validateCommands([{ command: 'Bad Name', description: 'x' }] as Cmd[]).length).toBeGreaterThan(0);
  });
});

describe('set-telegram-commands script', () => {
  it('registers the public menu on default scope and the operator menu per allowlisted id', async () => {
    const calls: Array<{ method: string; body: any; token: string }> = [];
    const server = createServer((request, response) => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '');
      let raw = '';
      request.on('data', (chunk) => {
        raw += String(chunk);
      });
      request.on('end', () => {
        calls.push({ token: match?.[1] ?? '', method: match?.[2] ?? '', body: raw ? JSON.parse(raw) : {} });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: true }));
      });
    });
    server.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    try {
      const result = await runScript(['--api-base', `http://127.0.0.1:${port}`], {
        BOT_TOKEN_CRYPTO_ZH: 'test-token',
        NEWBOT_OPERATOR_TELEGRAM_IDS: '42, 99',
      });

      expect(result.code).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary.ok).toBe(true);

      const setCommandsCalls = calls.filter((c) => c.method === 'setMyCommands');
      // 1 default + 2 operator scopes.
      expect(setCommandsCalls).toHaveLength(3);

      const defaultCall = setCommandsCalls.find((c) => c.body.scope.type === 'default');
      expect(defaultCall?.body.commands).toHaveLength((PUBLIC_COMMANDS as Cmd[]).length);
      expect((defaultCall?.body.commands as Cmd[]).some((c) => c.command === 'health')).toBe(false);

      const operatorCall = setCommandsCalls.find((c) => c.body.scope.type === 'chat' && c.body.scope.chat_id === 42);
      expect(operatorCall?.body.commands).toHaveLength((PUBLIC_COMMANDS as Cmd[]).length + (OPERATOR_COMMANDS as Cmd[]).length);
      expect((operatorCall?.body.commands as Cmd[]).some((c) => c.command === 'health')).toBe(true);

      expect(calls.some((c) => c.method === 'setChatMenuButton')).toBe(true);
      expect(calls.every((c) => c.token === 'test-token')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('dry-run touches no network and still reports the plan', async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    server.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    try {
      const result = await runScript(['--dry-run', '--api-base', `http://127.0.0.1:${port}`], {
        BOT_TOKEN_CRYPTO_ZH: 'test-token',
        NEWBOT_OPERATOR_TELEGRAM_IDS: '',
      });
      expect(result.code).toBe(0);
      expect(hits).toBe(0);
      expect(JSON.parse(result.stdout).dryRun).toBe(true);
    } finally {
      server.close();
    }
  });

  it('fails when no bot token is available', async () => {
    const result = await runScript(['--dry-run'], {
      BOT_TOKEN_CRYPTO_ZH: '',
      NEWBOT_OPERATOR_TELEGRAM_IDS: '',
    });
    expect(result.code).toBe(1);
  });

  it('persona map matches the token env used by the worker', () => {
    expect(PERSONA_TOKEN_ENV).toMatchObject({ crypto_zh: 'BOT_TOKEN_CRYPTO_ZH' });
  });
});
