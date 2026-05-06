/**
 * Simple account-link portal skeleton for Phase 5.
 */

import { getAccountLinkSessionByToken } from '../db/account_sessions';
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
      .cta { display:inline-block; margin-top:12px; background:#111827; color:#fff; text-decoration:none; padding:12px 18px; border-radius:12px; }
      ul { padding-left:18px; color:#374151; }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="badge">Phase 5 portal skeleton</span>
      <h1>连接你的交易账户</h1>
      <p>这一步先把账户接入入口搭起来。现在还是 portal 骨架，但已经能把会话、口令和页面入口打通，下一步就可以接 managed signer / 钱包签名流程。</p>
      <div class="box">
        <div>当前链接口令</div>
        <div class="token">${escapeHtml(token)}</div>
        <div style="margin-top:8px;color:#6b7280;">有效期到：${escapeHtml(session.expires_at.slice(0, 16).replace('T', ' '))}</div>
      </div>
      <ul>
        <li>推荐路径：managed signer</li>
        <li>后续会接入钱包签名和账户校验</li>
        <li>当前页面先用于确认会话与入口状态</li>
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
