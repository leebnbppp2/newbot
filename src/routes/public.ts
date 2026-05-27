/**
 * Public unauthenticated routes exposed by the Worker.
 */

import { getRecentSmokeReportRuns, getSmokeReportMetrics, type SmokeReportRun } from '../db/cron_runs';
import { getOrderGatewayReadiness } from '../lib/order_gateway';
import type { Env } from '../types';

export function handleHealthz(request: Request, env: Env): Response {
  void request;
  const readiness = getOrderGatewayReadiness(env);
  return json({
    ok: true,
    version: env.NEWBOT_VERSION ?? '0.1.0',
    readiness: {
      live_order_api: readiness.liveOrderApi,
      signing: readiness.signing,
      builder_attribution: readiness.builderAttribution,
      live_trading_allowlist: readiness.liveTradingAllowlist,
      warnings: readiness.warnings,
    },
  });
}

export function handleVersion(env: Env): Response {
  return json({ version: env.NEWBOT_VERSION ?? '0.1.0' });
}

export async function handleSmokeReport(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const expectedSecret = env.NEWBOT_SMOKE_REPORT_SECRET?.trim();
  const providedSecret = request.headers.get('x-newbot-smoke-report-secret')?.trim();
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const payload = await request.json() as { ok?: unknown; target?: unknown; checks?: unknown };
  if (typeof payload.ok !== 'boolean' || typeof payload.target !== 'string' || !Array.isArray(payload.checks)) {
    return json({ ok: false, error: 'invalid_smoke_report' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO cron_runs (job_name, status, detail)
     VALUES (?, ?, ?)`,
  )
    .bind('smoke', payload.ok ? 'ok' : 'failed', JSON.stringify(payload))
    .run();

  return json({ ok: true, stored: true });
}

export async function handleSmokeMetrics(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const expectedSecret = env.NEWBOT_SMOKE_REPORT_SECRET?.trim();
  const providedSecret = request.headers.get('x-newbot-smoke-report-secret')?.trim();
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const metrics = await getSmokeReportMetrics(env, 50);
  return json({
    ok: true,
    metrics: {
      total: metrics.total,
      passed: metrics.passed,
      failed: metrics.failed,
      pass_rate: metrics.passRate,
      environments: metrics.environments.map((environment) => ({
        environment: environment.environment,
        total: environment.total,
        passed: environment.passed,
        failed: environment.failed,
        latest_status: environment.latestStatus,
        latest_target: environment.latestTarget,
        latest_created_at: environment.latestCreatedAt,
      })),
    },
  });
}

export async function handleSmokeDashboard(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const expectedSecret = env.NEWBOT_SMOKE_REPORT_SECRET?.trim();
  const providedSecret = request.headers.get('x-newbot-smoke-report-secret')?.trim();
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const metrics = await getSmokeReportMetrics(env, 50);
  const recentRuns = await getRecentSmokeReportRuns(env, 2);
  return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>NewBot smoke dashboard</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; }
    body { margin: 0; padding: 32px; }
    main { max-width: 960px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .muted { color: #94a3b8; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
    .card, table { background: #111827; border: 1px solid #334155; border-radius: 14px; }
    .card { padding: 16px; }
    .label { color: #94a3b8; font-size: 13px; }
    .value { margin-top: 6px; font-size: 26px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #334155; text-align: left; vertical-align: top; }
    th { color: #cbd5e1; font-size: 13px; }
    tr:last-child td { border-bottom: 0; }
    a { color: #93c5fd; overflow-wrap: anywhere; }
    .ok { color: #86efac; }
    .failed { color: #fca5a5; }
  </style>
</head>
<body>
  <main>
    <h1>NewBot smoke dashboard</h1>
    <p class="muted">Read-only view from recent smoke reports. Auto-refreshes every 60 seconds. Secrets are not rendered.</p>
    <section class="cards" aria-label="Smoke summary">
      <div class="card"><div class="label">Total smoke runs</div><div class="value">${metrics.total}</div></div>
      <div class="card"><div class="label">Passed</div><div class="value ok">${metrics.passed}</div></div>
      <div class="card"><div class="label">Failed</div><div class="value failed">${metrics.failed}</div></div>
      <div class="card"><div class="label">Pass rate</div><div class="value">${formatPercent(metrics.passRate)}</div></div>
    </section>
    <h2>Environments</h2>
    <table>
      <thead><tr><th>Environment</th><th>Runs</th><th>Passed</th><th>Failed</th><th>Latest</th><th>Target</th><th>Updated</th></tr></thead>
      <tbody>
        ${metrics.environments.map((environment) => `<tr>
          <td>${escapeHtml(environment.environment)}</td>
          <td>${environment.total}</td>
          <td class="ok">${environment.passed}</td>
          <td class="failed">${environment.failed}</td>
          <td class="${environment.latestStatus === 'ok' ? 'ok' : 'failed'}">${escapeHtml(environment.latestStatus)}</td>
          <td><a href="${escapeHtml(environment.latestTarget)}">${escapeHtml(environment.latestTarget)}</a></td>
          <td>${escapeHtml(environment.latestCreatedAt)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <h2>Recent smoke runs</h2>
    <table>
      <thead><tr><th>Created</th><th>Environment</th><th>Status</th><th>Target</th><th>Checks</th></tr></thead>
      <tbody>
        ${recentRuns.map((run) => `<tr>
          <td>${escapeHtml(run.createdAt)}</td>
          <td>${escapeHtml(run.detail?.environment ?? 'unknown')}</td>
          <td class="${isRunOk(run) ? 'ok' : 'failed'}">${escapeHtml(isRunOk(run) ? 'ok' : 'failed')}</td>
          <td>${renderRunTarget(run.detail?.target)}</td>
          <td>${escapeHtml(formatRunChecks(run))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </main>
</body>
</html>`);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function isRunOk(run: SmokeReportRun): boolean {
  return run.detail?.ok === true || run.status === 'ok';
}

function renderRunTarget(target: string | undefined): string {
  if (!target) {
    return 'unknown';
  }
  const escapedTarget = escapeHtml(target);
  return `<a href="${escapedTarget}">${escapedTarget}</a>`;
}

function formatRunChecks(run: SmokeReportRun): string {
  const checks = run.detail?.checks ?? [];
  if (checks.length === 0) {
    return 'no checks';
  }
  return checks
    .slice(0, 3)
    .map((check) => `${check.name} ${check.ok ? 'ok' : 'failed'}`)
    .join(', ');
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
