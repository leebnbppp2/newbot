/**
 * Account-link portal routes for Phase 6.
 */

import { completeAccountLinkSession, getAccountLinkSessionByToken } from '../db/account_sessions';
import type { Env } from '../types';

export async function handleLinkPortal(env: Env, token: string): Promise<Response> {
  const session = await getAccountLinkSessionByToken(env, token);
  if (!session || session.status !== 'open' || Date.parse(session.expires_at) <= Date.now()) {
    return new Response('Link session not found or expired', { status: 404 });
  }

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NewBot 账户连接入口</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#f5f7fb; color:#111827; padding:32px; }
      .card { max-width:720px; margin:0 auto; background:#fff; border-radius:18px; padding:28px; box-shadow:0 10px 40px rgba(15,23,42,.08); }
      .badge { display:inline-block; background:#eef2ff; color:#4338ca; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:600; }
      h1 { margin:14px 0 10px; font-size:30px; }
      p { line-height:1.7; color:#374151; }
      .box { background:#f8fafc; border:1px solid #e5e7eb; border-radius:14px; padding:16px; margin:18px 0; }
      .token { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:20px; font-weight:700; letter-spacing:1px; }
      .cta { display:inline-block; margin-top:12px; background:#111827; color:#fff; text-decoration:none; padding:12px 18px; border-radius:12px; border:none; cursor:pointer; }
      .field { display:block; margin-top:14px; }
      .field span { display:block; margin-bottom:6px; color:#374151; font-size:14px; }
      .field input, .field select { width:100%; border:1px solid #d1d5db; border-radius:12px; padding:12px 14px; font-size:15px; box-sizing:border-box; }
      ul { padding-left:18px; color:#374151; }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="badge">Phase 6 portal</span>
      <h1>连接你的交易账户</h1>
      <p>这一步已经不只是展示骨架了。你现在可以把 managed signer 的基础信息填进来，系统会把绑定状态真正写进去，后面 Telegram 里就能直接识别到账户已绑定。</p>
      <div class="box">
        <div>当前链接口令</div>
        <div class="token">${escapeHtml(token)}</div>
        <div style="margin-top:8px;color:#6b7280;">有效期到：${escapeHtml(session.expires_at.slice(0, 16).replace('T', ' '))}</div>
      </div>
      <form method="post" action="/portal/link/${encodeURIComponent(token)}/complete">
        <label class="field">
          <span>接入方式</span>
          <select name="auth_mode">
            <option value="managed_signer">managed signer</option>
            <option value="wallet_signature">wallet signature</option>
          </select>
        </label>
        <label class="field">
          <span>账户备注</span>
          <input name="account_label" placeholder="比如：Dora 主账户" />
        </label>
        <label class="field">
          <span>Signer 地址</span>
          <input name="signer_address" placeholder="0x..." />
        </label>
        <label class="field">
          <span>Funder 地址</span>
          <input name="funder_address" placeholder="0x..." />
        </label>
        <button class="cta" type="submit">确认绑定账户</button>
      </form>
      <ul>
        <li>推荐路径：managed signer</li>
        <li>后续可以继续补真实钱包签名校验</li>
        <li>当前这一步已经会把账户状态写入系统</li>
      </ul>
      <a class="cta" href="https://t.me/LunaHermes_test_bot">回到 Telegram 继续</a>
    </div>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function handleLinkPortalComplete(request: Request, env: Env, token: string): Promise<Response> {
  const formData = await request.formData();
  const authMode = normalizeText(formData.get('auth_mode')) || 'managed_signer';
  const accountLabel = normalizeText(formData.get('account_label'));
  const signerAddress = normalizeAddress(formData.get('signer_address'));
  const funderAddress = normalizeAddress(formData.get('funder_address'));

  const session = await completeAccountLinkSession(env, token, {
    authMode,
    accountLabel,
    signerAddress,
    funderAddress,
  });

  if (!session) {
    return new Response('Link session not found or expired', { status: 404 });
  }

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NewBot 账户已绑定</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#f5f7fb; color:#111827; padding:32px; }
      .card { max-width:720px; margin:0 auto; background:#fff; border-radius:18px; padding:28px; box-shadow:0 10px 40px rgba(15,23,42,.08); }
      .badge { display:inline-block; background:#dcfce7; color:#166534; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:600; }
      h1 { margin:14px 0 10px; font-size:30px; }
      p { line-height:1.7; color:#374151; }
      .cta { display:inline-block; margin-top:16px; background:#111827; color:#fff; text-decoration:none; padding:12px 18px; border-radius:12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="badge">Link completed</span>
      <h1>账户已经绑定完成</h1>
      <p>这次绑定已经写进系统了。回到 Telegram 后，/account 会直接看到已绑定状态，接下来你就可以继续测试市场详情、模拟下单和订单列表。</p>
      <p>接入方式：${escapeHtml(authMode)}</p>
      <a class="cta" href="https://t.me/LunaHermes_test_bot">回到 Telegram 继续</a>
    </div>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAddress(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
