#!/usr/bin/env node

const options = parseArgs(process.argv.slice(2));
const workerUrl = normalizeWorkerUrl(options.target ?? process.env.WORKER_URL);

if (!workerUrl) {
  console.error('Usage: node scripts/smoke.mjs [--require-ready] https://<your-worker>.workers.dev');
  process.exit(1);
}

const checks = [];

try {
  const healthz = await fetchHealthz(workerUrl);
  checks.push(buildHealthzCheck(healthz));
  if (options.requireReady) {
    checks.push(buildRolloutReadinessCheck(healthz.payload?.readiness));
  }
  checks.push(await checkVersion(workerUrl));
  checks.push(await checkWebhookSecret(workerUrl));
} catch (error) {
  checks.push({
    name: 'smoke_runtime',
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
}

const ok = checks.every((check) => check.ok);
const payload = {
  ok,
  target: workerUrl.toString().replace(/\/$/, ''),
  checks,
};

const output = JSON.stringify(payload, null, 2);
if (ok) {
  console.log(output);
  process.exit(0);
}

console.error(output);
process.exit(1);

function parseArgs(args) {
  const options = {
    requireReady: false,
    target: null,
  };

  for (const arg of args) {
    if (arg === '--require-ready') {
      options.requireReady = true;
      continue;
    }
    if (!options.target) {
      options.target = arg;
    }
  }

  return options;
}

function normalizeWorkerUrl(value) {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

async function fetchHealthz(baseUrl) {
  const response = await fetch(new URL('/healthz', baseUrl));
  const payload = await parseJson(response);
  return { response, payload };
}

function buildHealthzCheck({ response, payload }) {
  const readiness = payload?.readiness;
  const ok = response.ok
    && payload?.ok === true
    && typeof payload?.version === 'string'
    && typeof readiness?.live_order_api === 'boolean'
    && typeof readiness?.signing === 'boolean'
    && typeof readiness?.builder_attribution === 'string'
    && typeof readiness?.live_trading_allowlist === 'boolean'
    && Array.isArray(readiness?.warnings);

  const allowlistState = readiness?.live_trading_allowlist ? 'enabled' : 'disabled';
  return {
    name: 'healthz',
    ok,
    detail: ok ? `healthz ok, version ${payload.version}, live allowlist ${allowlistState}` : `unexpected /healthz response: ${response.status}`,
  };
}

function buildRolloutReadinessCheck(readiness) {
  const blockers = [];
  if (!readiness?.live_order_api) {
    blockers.push('live order API not ready');
  }
  if (!readiness?.signing) {
    blockers.push('canonical signing not ready');
  }
  if (readiness?.builder_attribution === 'partial') {
    blockers.push('builder attribution partial');
  }
  if (Array.isArray(readiness?.warnings)) {
    blockers.push(...readiness.warnings);
  } else {
    blockers.push('readiness warnings missing');
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    name: 'rollout_readiness',
    ok: uniqueBlockers.length === 0,
    detail: uniqueBlockers.length === 0 ? 'rollout readiness has no blockers' : uniqueBlockers.join('; '),
  };
}

async function checkVersion(baseUrl) {
  const response = await fetch(new URL('/version', baseUrl));
  const payload = await parseJson(response);
  const ok = response.ok && typeof payload?.version === 'string' && payload.version.length > 0;

  return {
    name: 'version',
    ok,
    detail: ok ? `version ${payload.version}` : `unexpected /version response: ${response.status}`,
  };
}

async function checkWebhookSecret(baseUrl) {
  const response = await fetch(new URL('/telegram/webhook/crypto_zh', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'newbot-smoke-invalid-secret',
    },
    body: JSON.stringify({ update_id: -1 }),
  });
  const ok = response.status === 401;

  return {
    name: 'webhook_secret_enforced',
    ok,
    detail: ok ? 'webhook rejected invalid secret with 401' : `expected 401, got ${response.status}`,
  };
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
