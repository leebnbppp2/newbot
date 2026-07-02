// Self-healing Telegram webhook. Watches ngrok's local API for the current public
// URL and (re)points the Telegram webhook whenever it changes, so an ngrok restart
// (new free URL) never silently breaks the bot. Run under pm2 with --env-file=.dev.vars.
const BOT_TOKEN = process.env.BOT_TOKEN_CRYPTO_ZH;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const PERSONA = process.env.WEBHOOK_PERSONA_ID || 'crypto_zh';
const NGROK_API = process.env.NGROK_API_URL || 'http://127.0.0.1:4040/api/tunnels';
const INTERVAL_MS = Number(process.env.WEBHOOK_CHECK_INTERVAL_MS || 30000);

if (!BOT_TOKEN || !SECRET) {
  console.error('missing BOT_TOKEN_CRYPTO_ZH or TELEGRAM_WEBHOOK_SECRET; exiting');
  process.exit(1);
}

let current = null;

async function getNgrokUrl() {
  const r = await fetch(NGROK_API);
  if (!r.ok) throw new Error(`ngrok api HTTP ${r.status}`);
  const j = await r.json();
  const t = (j.tunnels || []).find((x) => typeof x.public_url === 'string' && x.public_url.startsWith('https://'));
  return t ? t.public_url : null;
}

async function setWebhook(base) {
  const url = `${base}/telegram/webhook/${PERSONA}`;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, secret_token: SECRET, drop_pending_updates: false }),
  });
  const j = await r.json();
  console.log(new Date().toISOString(), 'setWebhook', url, JSON.stringify(j));
  return j.ok === true;
}

async function tick() {
  try {
    const base = await getNgrokUrl();
    if (base && base !== current) {
      if (await setWebhook(base)) current = base;
    }
  } catch (e) {
    console.error(new Date().toISOString(), 'tick error:', e.message);
  }
}

setInterval(tick, INTERVAL_MS);
tick();
console.log(`webhook-updater watching ${NGROK_API} -> Telegram webhook (persona ${PERSONA}, every ${INTERVAL_MS}ms)`);
