# Phase 21 上线后 smoke 脚本

这一步把 NewBot 从“部署后手动 curl 看一眼”推进到“有一个固定、只读、可重复的上线后 smoke 检查”。

完成内容：

- 新增 `scripts/smoke.mjs`
  - 使用方式：`npm run smoke -- https://<your-worker>.workers.dev`
  - 也支持直接传 `WORKER_URL` 环境变量
  - 输出结构化 JSON，方便复制到部署记录或 CI 日志里

- smoke 检查覆盖三件事：
  - `GET /healthz`：确认返回 `ok: true`，并且 readiness 结构包含 live order API、signing、Builder attribution 和 warnings
  - `GET /version`：确认部署版本接口可读
  - `POST /telegram/webhook/crypto_zh`：用固定的无效 secret 请求，确认 webhook 返回 401

- 这次 smoke 是故意只读的
  - 不使用真实 Telegram bot token
  - 不用正确 webhook secret
  - 不发真实 message / callback payload
  - 不写入业务数据
  - 只确认部署入口和 webhook secret 防护还在

- 新增 npm script
  - `npm run smoke -- <worker-url>`

自动化验证覆盖：

- 新增 `tests/smoke-script.test.ts`
- 测试里启动本地 HTTP server，模拟真实 Worker 入口
- 验证 smoke 脚本会依次访问：
  - `/healthz`
  - `/version`
  - `/telegram/webhook/crypto_zh`
- 验证 webhook smoke 使用 `newbot-smoke-invalid-secret`，并把 401 当成通过
- 验证脚本成功时输出 `{ ok: true, checks: [...] }`

还没覆盖：

- 不做真实 Telegram 回包测试；那会需要真实 token、chat id，并可能污染线上对话。
- 不做真实下单 / portfolio API 检查；这些仍留给 readiness 和后续更细的灰度 runbook。
- 不自动部署，只负责部署后的快速检查。

一句话总结：

Phase 21 是上线后第一道安全 smoke：确认 Worker 活着、版本可读、readiness 结构正常，并且 webhook 不会接受错误 secret。
