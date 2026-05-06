const botToken = process.env.BOT_TOKEN;
const webhookUrl = process.env.WEBHOOK_URL;
const webhookSecret = process.env.WEBHOOK_SECRET;

if (!botToken || !webhookUrl || !webhookSecret) {
  console.error('Usage: BOT_TOKEN=... WEBHOOK_URL=... WEBHOOK_SECRET=... node scripts/set-webhook.mjs');
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  }),
});

const payload = await response.json();
if (!response.ok || payload.ok !== true) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
