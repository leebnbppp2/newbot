import { describe, expect, it } from 'vitest';

import { handleHealthz, handleSmokeDashboard, handleSmokeMetrics, handleSmokeReport, handleVersion } from '../src/routes/public';
import type { Env } from '../src/types';

type CronRunRow = {
  id: number;
  job_name: string;
  status: string;
  detail: string;
  created_at: string;
};

class FakeD1 {
  cronRuns: CronRunRow[] = [];

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }
}

class FakePreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    if (this.query.includes('INSERT INTO cron_runs')) {
      const [jobName, status, detail] = this.values as [string, string, string];
      this.db.cronRuns.push({
        id: this.db.cronRuns.length + 1,
        job_name: jobName,
        status,
        detail,
        created_at: new Date(0).toISOString(),
      });
      return { success: true };
    }

    throw new Error(`Unsupported run query: ${this.query}`);
  }

  async all<T>() {
    if (this.query.includes('FROM cron_runs')) {
      const [jobName, limit] = this.values as [string, number | undefined];
      const results = this.db.cronRuns
        .filter((row) => row.job_name === jobName)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit ?? 50);
      return { results: results as T[] };
    }

    throw new Error(`Unsupported all query: ${this.query}`);
  }
}

function makeEnv(overrides: Partial<Env> = {}, db: FakeD1 = new FakeD1()): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.6.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
    ...overrides,
  };
}

describe('public routes', () => {
  it('returns readiness details from /healthz for partial live config', async () => {
    const env = makeEnv({
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_BUILDER_TAG: 'newbot-phase18',
    });

    const response = handleHealthz(new Request('https://example.com/healthz'), env);
    const payload = await response.json() as {
      ok: boolean;
      version: string;
      readiness: {
        live_order_api: boolean;
        signing: boolean;
        builder_attribution: string;
        warnings: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe('0.6.0');
    expect(payload.readiness.live_order_api).toBe(true);
    expect(payload.readiness.signing).toBe(false);
    expect(payload.readiness.builder_attribution).toBe('partial');
    expect(payload.readiness.warnings).toEqual(expect.arrayContaining([
      'Builder Program 配置不完整，归因暂时不会完整生效。',
      'signing secret 还没配置，live 请求暂时不会带 canonical 签名头。',
    ]));
  });

  it('returns only version from /version', async () => {
    const response = handleVersion(makeEnv());
    const payload = await response.json() as { version: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ version: '0.6.0' });
  });

  it('stores an authenticated smoke report in cron_runs', async () => {
    const db = new FakeD1();
    const env = makeEnv({ NEWBOT_SMOKE_REPORT_SECRET: 'report-secret' }, db);
    const report = {
      ok: false,
      target: 'https://newbot.example.workers.dev',
      checks: [{ name: 'rollout_readiness', ok: false, detail: 'canonical signing not ready' }],
    };

    const response = await handleSmokeReport(new Request('https://example.com/ops/smoke-report', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-newbot-smoke-report-secret': 'report-secret',
      },
      body: JSON.stringify(report),
    }), env);
    const payload = await response.json() as { ok: boolean; stored: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true, stored: true });
    expect(db.cronRuns).toHaveLength(1);
    expect(db.cronRuns[0]).toMatchObject({ job_name: 'smoke', status: 'failed' });
    expect(JSON.parse(db.cronRuns[0]?.detail ?? '{}')).toMatchObject(report);
  });

  it('rejects smoke reports without the configured report secret', async () => {
    const db = new FakeD1();
    const env = makeEnv({ NEWBOT_SMOKE_REPORT_SECRET: 'report-secret' }, db);

    const response = await handleSmokeReport(new Request('https://example.com/ops/smoke-report', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-newbot-smoke-report-secret': 'wrong-secret',
      },
      body: JSON.stringify({ ok: true, target: 'https://newbot.example.workers.dev', checks: [] }),
    }), env);

    expect(response.status).toBe(401);
    expect(db.cronRuns).toHaveLength(0);
  });

  it('returns authenticated smoke metrics from recent cron_runs', async () => {
    const db = new FakeD1();
    db.cronRuns.push(
      {
        id: 1,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://old-production.example.workers.dev',
          environment: 'production',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:00:00.000Z',
      },
      {
        id: 2,
        job_name: 'smoke',
        status: 'failed',
        detail: JSON.stringify({
          ok: false,
          target: 'https://staging.example.workers.dev',
          environment: 'staging',
          checks: [{ name: 'rollout_readiness', ok: false }],
        }),
        created_at: '2026-05-27T08:10:00.000Z',
      },
      {
        id: 3,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://production.example.workers.dev',
          environment: 'production',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:20:00.000Z',
      },
      {
        id: 4,
        job_name: 'cleanup',
        status: 'failed',
        detail: '{}',
        created_at: '2026-05-27T08:30:00.000Z',
      },
    );
    const env = makeEnv({ NEWBOT_SMOKE_REPORT_SECRET: 'report-secret' }, db);

    const response = await handleSmokeMetrics(new Request('https://example.com/ops/smoke-metrics', {
      headers: { 'x-newbot-smoke-report-secret': 'report-secret' },
    }), env);
    const payload = await response.json() as {
      ok: boolean;
      metrics: {
        total: number;
        passed: number;
        failed: number;
        pass_rate: number;
        environments: Array<{ environment: string; total: number; passed: number; failed: number; latest_status: string; latest_target: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.metrics).toMatchObject({ total: 3, passed: 2, failed: 1, pass_rate: 0.667 });
    expect(payload.metrics.environments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        environment: 'production',
        total: 2,
        passed: 2,
        failed: 0,
        latest_status: 'ok',
        latest_target: 'https://production.example.workers.dev',
      }),
      expect.objectContaining({
        environment: 'staging',
        total: 1,
        passed: 0,
        failed: 1,
        latest_status: 'failed',
      }),
    ]));
    expect(JSON.stringify(payload)).not.toContain('old-production.example.workers.dev');
  });

  it('rejects smoke metrics without the configured report secret', async () => {
    const env = makeEnv({ NEWBOT_SMOKE_REPORT_SECRET: 'report-secret' });

    const response = await handleSmokeMetrics(new Request('https://example.com/ops/smoke-metrics', {
      headers: { 'x-newbot-smoke-report-secret': 'wrong-secret' },
    }), env);

    expect(response.status).toBe(401);
  });

  it('returns an authenticated smoke dashboard as minimal HTML', async () => {
    const db = new FakeD1();
    db.cronRuns.push(
      {
        id: 1,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://old-production.example.workers.dev',
          environment: 'production',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:00:00.000Z',
      },
      {
        id: 2,
        job_name: 'cleanup',
        status: 'failed',
        detail: JSON.stringify({ ok: false, target: 'https://cleanup.example', checks: [] }),
        created_at: '2026-05-27T08:05:00.000Z',
      },
      {
        id: 3,
        job_name: 'smoke',
        status: 'failed',
        detail: JSON.stringify({
          ok: false,
          target: 'https://staging.example.workers.dev?note=<bad>',
          environment: 'staging',
          checks: [{ name: 'rollout_readiness', ok: false }],
        }),
        created_at: '2026-05-27T08:10:00.000Z',
      },
      {
        id: 4,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://production.example.workers.dev',
          environment: 'production',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:20:00.000Z',
      },
    );
    const env = makeEnv({ NEWBOT_SMOKE_REPORT_SECRET: 'report-secret' }, db);

    const response = await handleSmokeDashboard(new Request('https://example.com/ops/smoke-dashboard', {
      headers: { 'x-newbot-smoke-report-secret': 'report-secret' },
    }), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('NewBot smoke dashboard');
    expect(html).toContain('Total smoke runs');
    expect(html).toContain('3');
    expect(html).toContain('Pass rate');
    expect(html).toContain('66.7%');
    expect(html).toContain('production');
    expect(html).toContain('https://production.example.workers.dev');
    expect(html).toContain('staging');
    expect(html).toContain('https://staging.example.workers.dev?note=&lt;bad&gt;');
    expect(html).not.toContain('old-production.example');
    expect(html).not.toContain('cleanup.example');
  });

  it('rejects smoke dashboard without the configured report secret', async () => {
    const env = makeEnv({ NEWBOT_SMOKE_REPORT_SECRET: 'report-secret' });

    const response = await handleSmokeDashboard(new Request('https://example.com/ops/smoke-dashboard', {
      headers: { 'x-newbot-smoke-report-secret': 'wrong-secret' },
    }), env);

    expect(response.status).toBe(401);
  });

});
