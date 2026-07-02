#!/usr/bin/env node
/**
 * Register the Telegram command menu (`setMyCommands`) so users can tap commands
 * from the "/" autocomplete and the input-bar Menu button instead of typing them.
 *
 * Talks to the Bot API directly — no worker deploy needed; run it once (and again
 * whenever the command list below changes). Reads the bot token(s) and the
 * operator allowlist from the environment, falling back to `.dev.vars`.
 *
 *   npm run tg:commands              # apply public menu (+ operator menu per allowlisted id)
 *   npm run tg:commands -- --dry-run # print the plan, touch nothing
 *   npm run tg:commands -- --api-base http://localhost:1234   # point at a fake API (tests)
 *
 * Command NAMES must be ascii [a-z0-9_] (Bot API rule); the Chinese aliases that
 * `webhook.ts` also accepts (/卖, /余额, /menu, …) still work when typed, they just
 * can't live in the native menu.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** persona id -> env var holding that persona's bot token. Mirrors src/agent/personas.ts. */
export const PERSONA_TOKEN_ENV = {
  crypto_zh: 'BOT_TOKEN_CRYPTO_ZH',
};

/** Shown to every user (default scope). Order here is the order Telegram displays. */
export const PUBLIC_COMMANDS = [
  { command: 'start', description: '开始 / 打开主菜单' },
  { command: 'markets', description: '浏览热门市场' },
  { command: 'find', description: '搜索市场：/find 关键词' },
  { command: 'detail', description: '查看市场详情：/detail 市场ID' },
  { command: 'buy', description: '买入：/buy 市场 yes 金额 价格' },
  { command: 'sell', description: '卖出 / 平仓（列出持仓点按钮）' },
  { command: 'positions', description: '我的持仓' },
  { command: 'orders', description: '我的订单' },
  { command: 'openorders', description: '未成交挂单' },
  { command: 'fills', description: '成交记录' },
  { command: 'cancel', description: '撤单：/cancel 订单ID' },
  { command: 'deposit', description: '充值 / 开通真实交易' },
  { command: 'balance', description: '查看余额' },
  { command: 'account', description: '账户状态' },
  { command: 'link', description: '绑定交易账户' },
];

/** Appended (after the public ones) only in operator chats. */
export const OPERATOR_COMMANDS = [
  { command: 'health', description: '运行健康 / 就绪状态' },
  { command: 'metrics', description: '冒烟指标' },
  { command: 'runbook', description: '灰度 Runbook / 环境切换' },
];

const NAME_RE = /^[a-z0-9_]{1,32}$/;

/** Enforce the Bot API constraints up front so a typo fails loudly, not silently at Telegram. */
export function validateCommands(commands) {
  const errors = [];
  const seen = new Set();
  for (const { command, description } of commands) {
    if (!NAME_RE.test(command)) errors.push(`bad command name: "${command}" (need ${NAME_RE})`);
    if (seen.has(command)) errors.push(`duplicate command: "${command}"`);
    seen.add(command);
    if (!description || description.length > 256) errors.push(`bad description for "${command}" (1..256 chars)`);
  }
  if (commands.length > 100) errors.push(`too many commands: ${commands.length} (max 100)`);
  return errors;
}

/** Minimal `.dev.vars` (dotenv-ish) reader; env vars win. Strips quotes + trailing ` # ...`. */
function readDevVars(path = '.dev.vars') {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, '');
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseArgs(argv) {
  const opts = { dryRun: false, apiBase: 'https://api.telegram.org' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--api-base') opts.apiBase = argv[++i];
  }
  return opts;
}

/** Keep only numeric ids; a leftover placeholder like `<your-telegram-user-id>` is dropped. */
function parseOperatorIds(value) {
  const all = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const ids = all.filter((id) => /^-?\d+$/.test(id));
  return { ids, skipped: all.filter((id) => !/^-?\d+$/.test(id)) };
}

/**
 * Node's built-in fetch (undici) ignores HTTPS_PROXY env vars, so behind a proxy
 * (e.g. GFW) a direct call to api.telegram.org gets ECONNRESET. Build a ProxyAgent
 * from the proxy env when the target isn't localhost. Returns null = direct connect.
 */
async function makeDispatcher(apiBase) {
  const host = new URL(apiBase).hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null; // never proxy tests / local
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxyUrl) return null;
  if (/^socks/i.test(proxyUrl)) {
    console.error(`⚠️  代理 ${proxyUrl} 是 socks，ProxyAgent 只支持 http(s) 代理；请设 HTTPS_PROXY=http://host:port（多数 Clash/V2Ray 同端口也提供 http 代理）`);
    return null;
  }
  try {
    const { ProxyAgent } = await import('undici');
    console.error(`ℹ️  经代理访问 Telegram：${proxyUrl}`);
    return new ProxyAgent(proxyUrl);
  } catch {
    return null; // undici absent — fall back to direct
  }
}

async function callBotApi(apiBase, token, method, body, dispatcher) {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (dispatcher) init.dispatcher = dispatcher;
  const response = await fetch(`${apiBase}/bot${token}/${method}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`${method} failed: HTTP ${response.status} ${data.description ?? ''}`.trim());
  }
  return data;
}

/** Register the menu for one persona: default (public) + per-operator (public+operator) scopes. */
async function applyPersona({ apiBase, token, personaId, operatorIds, dryRun, dispatcher, results }) {
  const scopes = [{ label: `${personaId}:default`, scope: { type: 'default' }, commands: PUBLIC_COMMANDS }];
  for (const id of operatorIds) {
    scopes.push({
      label: `${personaId}:operator:${id}`,
      scope: { type: 'chat', chat_id: Number(id) },
      commands: [...PUBLIC_COMMANDS, ...OPERATOR_COMMANDS],
    });
  }
  for (const { label, scope, commands } of scopes) {
    if (dryRun) {
      results.push({ target: label, ok: true, dryRun: true, count: commands.length });
      continue;
    }
    await callBotApi(apiBase, token, 'setMyCommands', { commands, scope, language_code: '' }, dispatcher);
    results.push({ target: label, ok: true, count: commands.length });
  }
  // Make sure the input-bar Menu button surfaces the command list (not a Web App / hidden).
  if (!dryRun) {
    await callBotApi(apiBase, token, 'setChatMenuButton', { menu_button: { type: 'commands' } }, dispatcher);
  }
  results.push({ target: `${personaId}:menu-button`, ok: true, dryRun });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const catalogErrors = [...validateCommands(PUBLIC_COMMANDS), ...validateCommands([...PUBLIC_COMMANDS, ...OPERATOR_COMMANDS])];
  if (catalogErrors.length > 0) {
    console.error('Command catalog invalid:\n' + catalogErrors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }

  const devVars = readDevVars();
  const { ids: operatorIds, skipped: skippedOperatorIds } = parseOperatorIds(
    process.env.NEWBOT_OPERATOR_TELEGRAM_IDS ?? devVars.NEWBOT_OPERATOR_TELEGRAM_IDS,
  );
  if (skippedOperatorIds.length > 0) {
    console.error(`⚠️  ignoring non-numeric operator id(s): ${skippedOperatorIds.join(', ')} — set real Telegram user ids in NEWBOT_OPERATOR_TELEGRAM_IDS`);
  }

  const dispatcher = opts.dryRun ? null : await makeDispatcher(opts.apiBase);

  const results = [];
  let applied = 0;
  for (const [personaId, tokenEnv] of Object.entries(PERSONA_TOKEN_ENV)) {
    const token = process.env[tokenEnv] ?? devVars[tokenEnv];
    if (!token) {
      results.push({ target: personaId, ok: false, detail: `missing token ${tokenEnv} (env or .dev.vars)` });
      continue;
    }
    try {
      await applyPersona({ apiBase: opts.apiBase, token, personaId, operatorIds, dryRun: opts.dryRun, dispatcher, results });
      applied++;
    } catch (error) {
      results.push({ target: personaId, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const ok = applied > 0 && results.every((r) => r.ok);
  const summary = {
    ok,
    dryRun: opts.dryRun,
    publicCommands: PUBLIC_COMMANDS.length,
    operatorCommands: OPERATOR_COMMANDS.length,
    operatorIds: operatorIds.length,
    skippedOperatorIds,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
