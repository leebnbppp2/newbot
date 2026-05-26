#!/usr/bin/env node

const workerUrl = normalizeWorkerUrl(process.argv[2] ?? process.env.WORKER_URL);

if (!workerUrl) {
  console.error('Usage: node scripts/smoke.mjs https://<your-worker>.workers.dev');
  process.exit(1);
}

const checks = [];

try {
  checks.push(await checkHealthz(workerUrl));
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

async function checkHealthz(baseUrl) {
  const response = await fetch(new URL('/healthz', baseUrl));
  const payload = await parseJson(response);
  const readiness = payload?.readiness;
  const ok = response.ok
    && payload?.ok === true
    && typeof payload?.version === 'string'
    && typeof readiness?.live_order_api === 'boolean'
    && typeof readiness?.signing === 'boolean'
    && typeof readiness?.builder_attribution === 'string'
    && Array.isArray(readiness?.warnings);

  return {
    name: 'healthz',
    ok,
    detail: ok ? `healthz ok, version ${payload.version}` : `unexpected /healthz response: ${response.status}`,
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
