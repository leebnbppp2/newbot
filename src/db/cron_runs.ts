import type { Env } from '../types';

export interface CronRunRow {
  id: number;
  job_name: string;
  status: string;
  detail: string | null;
  created_at: string;
}

export interface SmokeReportCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SmokeReportDetail {
  ok: boolean;
  target: string;
  environment?: string;
  checks: SmokeReportCheck[];
}

export interface SmokeReportRun {
  status: string;
  createdAt: string;
  detail: SmokeReportDetail | null;
}

export interface SmokeReportEnvironmentMetrics {
  environment: string;
  total: number;
  passed: number;
  failed: number;
  latestStatus: string;
  latestTarget: string;
  latestCreatedAt: string;
}

export interface SmokeReportMetrics {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  environments: SmokeReportEnvironmentMetrics[];
}

export async function getLatestSmokeReportRun(env: Env): Promise<SmokeReportRun | null> {
  const runs = await listRecentSmokeReportRuns(env, 1);
  return runs[0] ?? null;
}

export async function getLatestSmokeReportRunsByEnvironment(env: Env): Promise<SmokeReportRun[]> {
  const runs = await listRecentSmokeReportRuns(env, 20);
  const seen = new Set<string>();
  const results: SmokeReportRun[] = [];
  for (const run of runs) {
    const environment = run.detail?.environment;
    if (!environment || seen.has(environment)) {
      continue;
    }
    seen.add(environment);
    results.push(run);
  }
  return results.slice(0, 5);
}

export async function getLatestSmokeReportRunForEnvironment(env: Env, environment: string): Promise<SmokeReportRun | null> {
  const expectedEnvironment = environment.trim().toLowerCase();
  if (!expectedEnvironment) {
    return null;
  }

  const runs = await listRecentSmokeReportRuns(env, 50);
  return runs.find((run) => run.detail?.environment?.toLowerCase() === expectedEnvironment) ?? null;
}

export async function getSmokeReportMetrics(env: Env, limit = 50): Promise<SmokeReportMetrics> {
  const runs = await listRecentSmokeReportRuns(env, limit);
  const passed = runs.filter((run) => run.detail?.ok === true || run.status === 'ok').length;
  const failed = runs.length - passed;
  const environmentMap = new Map<string, SmokeReportEnvironmentMetrics>();

  for (const run of runs) {
    const detail = run.detail;
    const environment = detail?.environment?.trim();
    if (!detail || !environment) {
      continue;
    }

    const key = environment.toLowerCase();
    const existing = environmentMap.get(key);
    const passedIncrement = detail.ok ? 1 : 0;
    const failedIncrement = detail.ok ? 0 : 1;
    if (!existing) {
      environmentMap.set(key, {
        environment,
        total: 1,
        passed: passedIncrement,
        failed: failedIncrement,
        latestStatus: detail.ok ? 'ok' : 'failed',
        latestTarget: detail.target,
        latestCreatedAt: run.createdAt,
      });
      continue;
    }

    existing.total += 1;
    existing.passed += passedIncrement;
    existing.failed += failedIncrement;
  }

  return {
    total: runs.length,
    passed,
    failed,
    passRate: runs.length > 0 ? roundToThree(passed / runs.length) : 0,
    environments: Array.from(environmentMap.values()).slice(0, 10),
  };
}

async function listRecentSmokeReportRuns(env: Env, limit: number): Promise<SmokeReportRun[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, job_name, status, detail, created_at
     FROM cron_runs
     WHERE job_name = ?
     ORDER BY id DESC
     LIMIT ?`,
  )
    .bind('smoke', limit)
    .all<CronRunRow>();

  return results.map((row) => ({
    status: row.status,
    createdAt: row.created_at,
    detail: parseSmokeReportDetail(row.detail),
  }));
}

function parseSmokeReportDetail(value: string | null): SmokeReportDetail | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { ok?: unknown; target?: unknown; environment?: unknown; checks?: unknown };
    if (typeof parsed.ok !== 'boolean' || typeof parsed.target !== 'string' || !Array.isArray(parsed.checks)) {
      return null;
    }

    const checks = parsed.checks
      .filter((check): check is { name: string; ok: boolean; detail?: string } => (
        typeof check === 'object'
        && check !== null
        && typeof (check as { name?: unknown }).name === 'string'
        && typeof (check as { ok?: unknown }).ok === 'boolean'
      ))
      .map((check) => {
        const result: SmokeReportCheck = {
          name: check.name,
          ok: check.ok,
        };
        if (typeof check.detail === 'string') {
          result.detail = check.detail;
        }
        return result;
      });

    const result: SmokeReportDetail = {
      ok: parsed.ok,
      target: parsed.target,
      checks,
    };
    if (typeof parsed.environment === 'string' && parsed.environment.trim().length > 0) {
      result.environment = parsed.environment.trim();
    }
    return result;
  } catch (_error) {
    return null;
  }
}

function roundToThree(value: number): number {
  return Math.round(value * 1000) / 1000;
}
