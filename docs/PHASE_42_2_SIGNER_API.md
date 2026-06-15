# Phase 42.2 — signer service 接口设计(custodial)

> 状态:**设计草案(尚未实现)**。本文细化 [PHASE_42.md](./PHASE_42.md) §42.2,定义 NewBot Worker 与独立 signer service 之间的内部契约。首发模式 = **custodial 托管**:signer service 持有并加密保管用户私钥,服务端代签 EIP-712 订单。

## 1. 信任模型与边界

```
Telegram ──> NewBot Worker (Cloudflare) ──HTTP+HMAC──> signer service (Node) ──官方SDK──> Polymarket CLOB / Data API
                  │                                          │
            只存非密资料(D1)                          独占密钥库 + per-user L2 creds
```

原则:

- **Worker 永不接触私钥**。Worker 只用 `(bot_id, telegram_user_id)` 标识用户;signer service 内部把它映射到密钥与 L2 creds。
- **signer service 是唯一持密钥方**。私钥加密存于 signer 自己的库(KMS / 封套加密),不进 Worker、不进 D1 `user_trading_credentials` 的传输路径。
- signer service **不对公网开放**,只接受来自 Worker 的、带合法内部签名的请求。
- 复用 Polygon mainnet:`chainId = 137`。

## 2. Worker ↔ signer 内部鉴权(复用现有 envelope)

沿用 `src/lib/order_gateway.ts:358-408` 已实现的签名头,signer 侧做对称校验,**无需新造协议**:

| Header | 含义 |
|--------|------|
| `authorization: Bearer <POLYMARKET_ORDER_API_KEY>` | 内部服务 API key(粗粒度准入) |
| `x-auth-mode` | 账户 auth_mode(`managed_signer` 等) |
| `x-signature-type` | 映射后的签名类型(见 §6) |
| `x-order-signature` | HMAC-SHA256(signatureInput, key=`<authMode>:<signingSecret>`) |
| `x-order-body-sha256` | 请求体 SHA-256(防篡改) |
| `x-order-signature-input` | `body_sha256=..,timestamp_ms=..,nonce=..,auth_mode=..,protocol_version=polymarket_clob_v2` |
| `x-order-protocol-version` | `polymarket_clob_v2` |
| `x-order-timestamp-ms` / `x-order-nonce` | 时间戳 / nonce |

signer 校验步骤:
1. `authorization` Bearer 匹配。
2. 重算 `body_sha256` 与 `x-order-body-sha256` 一致(请求体未篡改)。
3. 用共享 `signingSecret` 重算 HMAC,与 `x-order-signature` 一致。
4. `timestamp_ms` 在允许时窗内(如 ±60s),`nonce` 未重放(短期缓存去重)。

> 这套头当前只在「有 signing secret」时附带。Phase 42 把它定为 signer 调用的**强制**前置(readiness 会校验 `signing` 必须为 true)。

## 3. 用户 → 密钥映射 & onboarding(custodial)

custodial 下,signer 需要在「用户首次绑定」时拿到/生成一把可控钱包:

- **托管钱包来源(二选一,首发推荐 a)**
  - (a) signer 为用户**生成**一把托管 EOA(或 Polymarket proxy/safe),私钥加密入库。用户只需向其充值。
  - (b) 用户在 portal 提交自有私钥 → 加密交给 signer 保管(风险更高,不推荐首发)。
- **L2 creds**:首单前 signer 用该钱包做 L1(EIP-712)→ `createOrDeriveApiKey()` 得到 `{key, secret, passphrase}`,按 `(bot_id, telegram_user_id)` 缓存复用。
- Worker 现有 portal(`routes/portal.ts`)在绑定完成时,改为调用 signer 的 `POST /accounts/provision` 拿回 `signer_address / funder_address / deposit_address`,写入 `user_trading_accounts`(列已存在)。

## 4. 接口清单

所有路径相对 `POLYMARKET_ORDER_API_BASE`。**粗体**为相对现有 Worker 调用需新增/补字段处。

| # | Method & Path | 用途 | Worker 调用点 |
|---|---------------|------|---------------|
| 1 | `POST /orders` | 下单 | `order_gateway.ts:98` |
| 2 | `GET /orders/:id` | 单订单状态回查 | `order_gateway.ts:411` |
| 3 | `POST /orders/:id/cancel` | 撤单 | `order_gateway.ts:167` |
| 4 | `GET /orders/open` | 未成交订单(分页) | `order_gateway.ts:190` |
| 5 | `GET /portfolio/positions` | 持仓 | `order_gateway.ts:209` |
| 6 | `GET /portfolio/fills` | 成交记录 | `order_gateway.ts:228` |
| 7 | **`POST /accounts/provision`** | 绑定时开通托管钱包 | 新增(portal) |
| 8 | **`GET /accounts/:user/readiness`** | allowance/creds/balance 就绪检查 | 新增(readiness) |
| 9 | **`POST /accounts/:user/allowance`** | 触发 USDC/CTF 授权 | 新增(资金前置) |

> 路径与 1–6 保持和现有 Worker 调用**完全一致**,因此 signer 落地后 Worker 的 URL/缓存逻辑无需改;只需补请求体新增字段(§4.1)和状态归一化(§7)。

### 4.1 `POST /orders` — 下单

请求体(在现有 `buildLiveOrderPayload` 基础上 **加粗为新增**):

```json
{
  "bot_id": "crypto_zh",
  "telegram_user_id": "123456",
  "token_id": "710539...big-int-string",
  "market_slug": "will-x-happen",
  "market_question": "Will X happen?",
  "outcome": "Yes",
  "amount_usdc": 25.0,
  "side": "BUY",
  "order_type": "FOK",
  "price": 0.62,
  "auth_mode": "managed_signer",
  "signature_type": 1,
  "client_order_id": "nbo-1718000000000-ab12cd34",
  "timestamp_ms": 1718000000000,
  "nonce": "…",
  "builder_tag": "newbot",
  "builder_api_key_hint": "****ab12"
}
```

字段说明:
- **`bot_id` / `telegram_user_id`**:必填,signer 据此选密钥与 L2 creds。**当前 `buildLiveOrderPayload` 未带,需在 42.4 补上。**
- `token_id`:已有,来自 `MarketOutcome.tokenId`(真实 `clobTokenIds`)。
- **`side`**:首发只用 `BUY`;预留 `SELL`(平仓)。
- **`order_type`**:市价买入用 `FOK`(默认)或 `FAK`;限价用 `GTC/GTD`。
- **`price`**:市价单可作为可接受上限(滑点保护);limit 单为挂单价。
- **`signature_type`**:`0 EOA / 1 POLY_PROXY / 2 POLY_GNOSIS_SAFE`(§6 映射)。
- `tick_size` / `neg_risk`:**不由 Worker 传**,signer 自行 `getTickSize(tokenID)` 与按市场判定 `negRisk`。
- `client_order_id`:幂等键(§9)。

成功响应(对齐 `ExecuteBuyOrderResult` 消费,见 `order_gateway.ts:104-122`):

```json
{
  "orderId": "0xabc…",
  "status": "matched",
  "transactionHashes": ["0x…"],
  "filled_size": 40.3,
  "avg_price": 0.62,
  "amount_usdc": 25.0
}
```

Worker 只强依赖 `orderId` 与 `status`;其余进 `detail`/`trade_events.payload_json` 备查。

### 4.2 `GET /orders/:id`

响应:`{ "status": "matched", "filled_size": .., "avg_price": .., "remaining_size": .. }`。Worker 取 `status` 经 §7 归一化回写 `trade_events`。

### 4.3 `POST /orders/:id/cancel`

请求体(Worker 现有,见 `order_gateway.ts:158-164`):`{ order_id, timestamp_ms, nonce, auth_mode, action:"cancel" }`。需补 `bot_id`/`telegram_user_id` 以定位 creds。
响应:`{ "orderId": "..", "status": "cancelled" }`。

### 4.4 `GET /orders/open?bot_id=&telegram_user_id=`

响应必须是 **`{ "orders": RemoteOpenOrder[] }`**,每项严格匹配 `replies.ts:32`:

```json
{ "orders": [
  { "orderId": "0x…", "marketSlug": "will-x-happen", "outcome": "Yes", "amountUsdc": 25.0, "status": "live" }
]}
```

### 4.5 `GET /portfolio/positions?bot_id=&telegram_user_id=`

响应 **`{ "positions": RemotePosition[] }`**,匹配 `replies.ts:40`:

```json
{ "positions": [
  { "marketSlug": "will-x-happen", "outcome": "Yes",
    "sizeUsdc": 25.0, "avgPrice": 0.60, "currentPrice": 0.64,
    "realizedPnl": 0.0, "unrealizedPnl": 1.0 }
]}
```
> 持仓/盈亏的真实来源是 **Data API**(`data-api.polymarket.com`),不是 CLOB;由 signer 拉取并归一化成上面结构。

### 4.6 `GET /portfolio/fills?bot_id=&telegram_user_id=`

响应 **`{ "fills": RemoteFill[] }`**,匹配 `replies.ts:50`:

```json
{ "fills": [
  { "marketSlug": "will-x-happen", "outcome": "Yes", "amountUsdc": 25.0, "price": 0.62, "side": "BUY" }
]}
```

### 4.7 资金/账户类(新增)

- `POST /accounts/provision` → `{ signer_address, funder_address, deposit_address_evm }`
- `GET /accounts/:user/readiness` → `{ creds_ready, allowance_ready, usdc_balance, blocking: ["allowance"|"creds"|"balance"|"geoblock"] }`
- `POST /accounts/:user/allowance` → 触发 USDC.e + CTF/Exchange 授权,返回 `{ tx_hashes, allowance_ready }`

## 5. signer 内部 → 官方 SDK 映射

| signer 接口 | 官方 `@polymarket/clob-client` |
|-------------|--------------------------------|
| `POST /orders`(市价) | `createAndPostMarketOrder({tokenID, amount, side, price?, orderType}, {tickSize, negRisk})` |
| `POST /orders`(限价) | `createOrder({tokenID, price, size, side})` + `postOrder(signed, GTC/GTD)` |
| `GET /orders/:id` | `getOrder(orderID)` |
| `POST /orders/:id/cancel` | `cancelOrder({orderID})` |
| `GET /orders/open` | `getOpenOrders({market?, asset_id?})` |
| `GET /portfolio/fills` | `getTrades(...)` |
| `GET /portfolio/positions` | Data API `GET /positions?user=<funder>`(SDK 外) |
| L2 鉴权 | `createOrDeriveApiKey()` → `new ClobClient(host,137,signer,creds)` |
| tickSize | `getTickSize(tokenID)` |

## 6. 签名类型映射

Worker 的 `auth_mode` → 官方 `SignatureType` 整数:

| auth_mode | signature_type | 含义 |
|-----------|----------------|------|
| `wallet_signature` | `0` EOA | 用户自有 EOA |
| `managed_signer`(首发) | `1` POLY_PROXY | EOA 控制的 Polymarket proxy |
| (gnosis safe) | `2` POLY_GNOSIS_SAFE | 预留 |

> 现有 `buildLiveOrderPayload` 产出的 `clob_delegate`/`clob_wallet` 字符串需替换为上述整数枚举(42.4 改造点)。

## 7. 状态归一化

signer 原始状态 → Worker `normalizeLiveStatus`(`order_gateway.ts:425`)产物:

| CLOB 状态 | Worker status |
|-----------|---------------|
| `live` / `submitted` | `live_submitted` |
| `matched` | `live_matched` |
| `cancelled` | `live_cancelled` |
| `delayed` / `unmatched` | 需在 42.4 **新增**对应分支(当前会原样透传) |

## 8. 错误模型(统一 envelope)

非 2xx 一律返回:

```json
{ "error": { "code": "INSUFFICIENT_ALLOWANCE", "message": "...", "retryable": false } }
```

错误码 → Worker 用户文案:

| code | HTTP | 用户中文提示方向 |
|------|------|------------------|
| `INSUFFICIENT_BALANCE` | 402 | 余额不足,请先充值 |
| `INSUFFICIENT_ALLOWANCE` | 409 | 授权未完成,引导走 allowance 授权 |
| `CREDS_NOT_READY` | 409 | 账户还在开通中,稍后再试 |
| `GEOBLOCKED` | 451 | 当前地区不可交易 |
| `ORDER_REJECTED` | 422 | CLOB 拒单(价格/规模/tick) |
| `SIGNING_FAILED` | 500 | 内部签名失败,已记录 |
| `UPSTREAM_TIMEOUT` | 504 | 暂时不可用 → Worker 走缓存回退(读类) |

> Worker 现状是 `!response.ok` 直接 `throw`(`order_gateway.ts:105`)。42.4 需按 code 分流:读类回退缓存,写类给精准文案。

## 9. 幂等

- `client_order_id`(Worker 已生成,`order_gateway.ts:333`)作为幂等键。
- signer 对同一 `client_order_id` 的重复 `POST /orders` 返回首次结果,不重复下单。
- Worker 侧可叠加 `idempotency_keys` 表(schema 已存在)做二次保险。

## 10. 安全要求(custodial 关键项)

- 私钥加密存储:KMS 或封套加密,**明文私钥只在签名内存期存在**。
- 最小权限:signer 服务网络仅允许 Worker 入站 + Polygon RPC / CLOB / Data API 出站。
- 全量审计日志:每次签名/下单/撤单 → 谁、何时、哪笔(可与 `trade_events` 对账)。
- 限额在 signer 与 Worker **双侧**都校验(纵深防御):单笔上限、日上限。
- 应急:密钥泄露预案、一键停用 allowlist。

## 11. 落地后需同步改的 Worker 点(驱动 42.4)

1. ✅ `buildLiveOrderPayload` 补 `bot_id / telegram_user_id / side / order_type / price`,`signature_type` 改整数枚举(已实现 2026-06-15)。
2. ✅ `normalizeLiveStatus` 补 `delayed/unmatched` 分支(已实现)。
3. ✅ `executeBuyOrder` / `cancelLiveOrder` 的 `!response.ok` 改为抛 `LiveOrderError`(`mapLiveOrderError` 按 §8 错误码出中文文案);读类 fetch* 保持缓存回退(已覆盖 UPSTREAM_TIMEOUT 语义)。已实现。
4. ⏳ `getOrderGatewayReadiness` 增 `signerReachable / allowanceReady / credsReady` —— **延后到 signer 落地后**:`signerReachable` 需对 signer 健康端点异步探测(本设计未定义全局健康端点,落地 signer 时补);`allowanceReady / credsReady` 是 per-user 的,应走 §4.7 的 `GET /accounts/:user/readiness`,不属于无用户上下文的全局 readiness。
5. ⏳ portal 完成绑定时调用 `POST /accounts/provision`(随 42.2 signer 落地)。

## 12. 验收标准(42.2)

- signer service 用真实小额在 mainnet 跑通 下单→查单→撤单→持仓→成交 全链路。
- 1、4、5、6 号接口返回结构与 `RemoteOpenOrder/RemotePosition/RemoteFill` **逐字段对齐**,Worker 渲染无需改 `replies.ts`。
- 内部 HMAC envelope 校验通过;伪造/过期/重放请求被拒。
- 错误码能正确触发 Worker 的缓存回退(读)与精准文案(写)。
- 重复 `client_order_id` 不产生重复真实单。
