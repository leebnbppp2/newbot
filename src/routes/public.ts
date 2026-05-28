/**
 * Public unauthenticated routes exposed by the Worker.
 */

import { getRecentSmokeReportRuns, getSmokeReportMetrics, getSmokeReportTrend, type SmokeReportRun, type SmokeReportTrend } from '../db/cron_runs';
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

  const selectedEnvironment = parseEnvironmentFilter(new URL(request.url).searchParams.get('env'));
  const metrics = await getSmokeReportMetrics(env, 50, selectedEnvironment);
  const trend = await getSmokeReportTrend(env, 10, selectedEnvironment);
  const recentRuns = await getRecentSmokeReportRuns(env, 2, selectedEnvironment);
  const smokeFreshness = getSmokeFreshness(recentRuns);
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
    .env-nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 8px; }
    .env-nav a { border: 1px solid #334155; border-radius: 999px; padding: 7px 12px; background: #111827; color: #cbd5e1; text-decoration: none; }
    .env-nav a[aria-current="page"] { border-color: #60a5fa; background: #1e3a8a; color: #dbeafe; font-weight: 700; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
    .card, table { background: #111827; border: 1px solid #334155; border-radius: 14px; }
    .card { padding: 16px; }
    .label { color: #94a3b8; font-size: 13px; }
    .value { margin-top: 6px; font-size: 26px; font-weight: 700; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 6px 10px; font-size: 18px; }
    .badge.ok { background: rgba(22, 163, 74, 0.14); }
    .badge.failed { background: rgba(220, 38, 38, 0.14); }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #334155; text-align: left; vertical-align: top; }
    th { color: #cbd5e1; font-size: 13px; }
    tr:last-child td { border-bottom: 0; }
    a { color: #93c5fd; overflow-wrap: anywhere; }
    .ok { color: #86efac; }
    .failed { color: #fca5a5; }
    .trend { background: #111827; border: 1px solid #334155; border-radius: 14px; padding: 16px; margin: 24px 0; }
    .sequence { margin-top: 8px; font-weight: 700; letter-spacing: 0.02em; }
    .trend-dots { display: flex; gap: 6px; margin-top: 12px; }
    .trend-dot { width: 18px; height: 18px; border-radius: 999px; border: 1px solid #334155; }
    .trend-dot.ok { background: #22c55e; }
    .trend-dot.failed { background: #ef4444; }
  </style>
</head>
<body>
  <main>
    <h1>NewBot smoke dashboard</h1>
    <p class="muted">Read-only view from recent smoke reports. Auto-refreshes every 60 seconds. Secrets are not rendered.</p>
    ${renderEnvironmentNav(selectedEnvironment)}
    ${selectedEnvironment ? `<p class="muted">Environment filter: ${escapeHtml(selectedEnvironment)}</p>` : ''}
    <section class="cards" aria-label="Smoke summary">
      <div class="card"><div class="label">Overall status</div><div class="value"><span class="badge ${metrics.failed > 0 ? 'failed' : 'ok'}">${escapeHtml(formatDashboardStatus(metrics.total, metrics.failed))}</span></div></div>
      <div class="card"><div class="label">Latest smoke</div><div class="value">${escapeHtml(formatLatestSmoke(recentRuns))}</div></div>
      <div class="card"><div class="label">Freshness</div><div class="value"><span class="badge ${smokeFreshness.isStale ? 'failed' : 'ok'}">${escapeHtml(smokeFreshness.label)}</span></div></div>
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
    <section class="trend" aria-label="Smoke trend">
      <h2>Smoke trend (last 10)</h2>
      <p class="muted">Newest first, based on the latest ${trend.total} smoke reports.</p>
      <div>Trend pass rate: ${formatPercent(trend.passRate)} (${trend.passed} passed / ${trend.failed} failed)</div>
      <div class="sequence">${escapeHtml(formatTrendSequence(trend))}</div>
      ${renderTrendDots(trend)}
    </section>
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
    .map((check) => {
      const status = check.ok ? 'ok' : 'failed';
      return check.detail ? `${check.name} ${status}: ${check.detail}` : `${check.name} ${status}`;
    })
    .join(', ');
}

function formatTrendSequence(trend: SmokeReportTrend): string {
  if (trend.runs.length === 0) {
    return 'no smoke reports yet';
  }
  return trend.runs.map((run) => (isRunOk(run) ? 'ok' : 'failed')).join(' · ');
}

function formatDashboardStatus(total: number, failed: number): string {
  if (total === 0) {
    return 'No data';
  }
  return failed > 0 ? 'Attention' : 'Healthy';
}

function formatLatestSmoke(recentRuns: SmokeReportRun[]): string {
  return recentRuns[0]?.createdAt ?? 'no smoke reports yet';
}

const SMOKE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

function getSmokeFreshness(recentRuns: SmokeReportRun[]): { label: string; isStale: boolean } {
  const latest = recentRuns[0]?.createdAt;
  if (!latest) {
    return { label: 'No data', isStale: true };
  }

  const latestMs = Date.parse(latest);
  if (!Number.isFinite(latestMs)) {
    return { label: 'Unknown', isStale: true };
  }

  return Date.now() - latestMs > SMOKE_STALE_AFTER_MS
    ? { label: 'Stale', isStale: true }
    : { label: 'Fresh', isStale: false };
}

function renderTrendDots(trend: SmokeReportTrend): string {
  if (trend.runs.length === 0) {
    return '';
  }
  const dots = trend.runs
    .map((run) => {
      const status = isRunOk(run) ? 'ok' : 'failed';
      return `<span class="trend-dot ${status}" title="${status}" aria-label="${status}"></span>`;
    })
    .join('');
  return `<div class="trend-dots" aria-label="Smoke trend dots">${dots}</div>`;
}

function renderEnvironmentNav(selectedEnvironment: string | undefined): string {
  const links = [
    { label: 'All', href: '/ops/smoke-dashboard', environment: undefined },
    { label: 'Production', href: '/ops/smoke-dashboard?env=production', environment: 'production' },
    { label: 'Staging', href: '/ops/smoke-dashboard?env=staging', environment: 'staging' },
    { label: 'Canary', href: '/ops/smoke-dashboard?env=canary', environment: 'canary' },
  ];
  const renderedLinks = links
    .map((link) => {
      const isCurrent = link.environment === selectedEnvironment;
      return `<a href="${link.href}"${isCurrent ? ' aria-current="page"' : ''}>${link.label}</a>`;
    })
    .join('');
  return `<nav class="env-nav" aria-label="Environment filter">${renderedLinks}</nav>`;
}

function parseEnvironmentFilter(value: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9_-]{1,32}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
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
