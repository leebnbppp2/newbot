# Phase 42 plan — 接入 Polymarket 真实交易

> 状态:**规划草案(尚未实现)**。本文不声称已完成,只盘点现状、定义缺口、给出落地方案与验收标准。实现落地后再回写 README 的「当前 Phase」行为段。

## 0. 目标

把 NewBot 从「真实行情 + 模拟下单」推进到「真实行情 + 真实下单/撤单/持仓」,即让 `/buy`、`/cancel`、`/openorders`、`/positions`、`/fills` 真正作用在 Polymarket CLOB 上,并保证可灰度、可回退、可审计。

非目标(本阶段不做):做市/挂单策略、自动平仓、多链充提的完整实现、AI 选市决策。

## 1. 现状盘点(已经具备的部分)

| 能力 | 现状 | 位置 |
|------|------|------|
| 市场行情(读) | **已真连** Polymarket Gamma API | `src/lib/markets.ts:15` |
| CLOB token id | **已具备**:从 `clobTokenIds` 解析进 `outcome.tokenId` | `src/lib/markets.ts:152-166` |
| `/buy` 链路 | 已把 `selectedOutcome.tokenId` 传入网关,带 allowlist 灰度 | `src/routes/webhook.ts:547-580` |
| 订单网关骨架 | live/simulated 双路径、状态回查、撤单、持仓/成交读、缓存 | `src/lib/order_gateway.ts` |
| readiness | `/healthz`、`/health` 已暴露 live/signing/builder/allowlist 状态 | `order_gateway.ts:241-271` |
| 账户数据模型 | `user_trading_accounts`(auth_mode / signature_type / signer / funder / geoblock)+ `user_trading_credentials`(encrypted_payload)+ `withdrawal_requests` 已建表 | `migrations/0001_init.sql:16-48,124-135` |

**结论:数据模型和调用链路已为真实交易预留好,缺口集中在「签名协议」与「密钥/资金链路」两处。**

## 2. 缺口(为什么现在还连不上真实 Polymarket)

当前 `order_gateway.ts` 发的是一套**自定义协议**,与 Polymarket 官方 CLOB 协议不匹配:

| 维度 | 现有实现 | Polymarket 官方 CLOB 要求 |
|------|----------|---------------------------|
| Base URL | 抽象 `POLYMARKET_ORDER_API_BASE`(无默认值,未指向真实主机) | `https://clob.polymarket.com` |
| 鉴权 | `Bearer {apiKey}` + 自定义 `x-order-*` HMAC 头 | **L1**(EIP-712 钱包签名,建/取 API key)+ **L2**(`POLY_ADDRESS / POLY_SIGNATURE(HMAC) / POLY_TIMESTAMP / POLY_API_KEY / POLY_PASSPHRASE`) |
| 订单体 | 平铺 JSON(`market_slug` / `amount_usdc` …),`protocol: 'polymarket_clob_v1'` 仅是字符串标签 | **EIP-712 签名的 Order 结构**:`salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType, signature` |
| 签名类型 | `clob_delegate` / `clob_wallet`(自造字符串) | `SignatureType` 枚举:`EOA=0 / POLY_PROXY=1 / POLY_GNOSIS_SAFE=2` |
| 下单语义 | 单一 POST,无 order type | `GTC / GTD / FOK / FAK`;市价单走 `createMarketOrder`(FOK/FAK)+ `tickSize` + `negRisk` |
| 撤单 | `POST {base}/orders/{id}/cancel` + 自定义签名 | L2 鉴权下的 cancel 接口 |
| 持仓来源 | `{base}/portfolio/positions` 自定义形状 | 实时持仓来自 Data API(`data-api.polymarket.com`),CLOB 提供未成交单/成交 |
| 资金前置 | 无 | **链上 allowance**:USDC.e 与 CTF/Exchange 合约授权,未授权无法成交 |
| 密钥 | 无私钥概念,只有 apiKey 字符串 | 下单必须用用户 EOA(或其控制的 Proxy/Safe)**私钥做 EIP-712 签名** |

此外有一个 **运行环境约束**:官方 `@polymarket/clob-client` 依赖 `ethers`,EIP-712 用的是 secp256k1 曲线,而 Cloudflare Workers 的 WebCrypto 只内置 P-256/384/521,**不含 secp256k1**。在 Worker 内直接签名需引入纯 JS 实现(如 `viem` / `@noble/curves`)。

## 3. 架构选型(两条路,推荐 B)

### Path A — Worker 内直连 CLOB
在 Worker 里用 `viem`/`@noble/curves` 实现 EIP-712 签名 + L1/L2 鉴权,加密私钥存 D1 `user_trading_credentials`,签名时在内存解密。
- 优点:无额外服务。
- 缺点:secp256k1 需自带库;**私钥托管落在 Worker/D1**,密钥管理与合规风险最高;Worker CPU/内存预算紧。

### Path B —(推荐)独立签名/中继服务,Worker 保持薄
新建一个 **signer service**(Node 或 Python,直接用官方 `@polymarket/clob-client` / `py-clob-client`),由它持有密钥、做 EIP-712 签名、与真实 CLOB/Data API 通信并归一化返回。NewBot Worker 继续作为前端,通过现有 `POLYMARKET_ORDER_API_BASE` + 内部签名头调用它。
- 优点:**复用官方 SDK**(签名/allowance/tickSize/negRisk 都已正确实现),把密钥托管和 secp256k1 关在一个可控服务里;Worker 改动最小,现有 `order_gateway.ts` 抽象几乎不动。
- 缺点:多一个需要部署与加固的服务。

> 现有 `order_gateway.ts` 的形状(POST 到抽象 base + 自定义鉴权)本就是 Path B 的雏形。推荐落地 Path B:**先把那个「中继」做成真实存在、且真说 CLOB 协议的服务**,Worker 侧只需把字段对齐和 readiness/错误语义补全。

## 4. 落地子阶段

### 42.1 决策与脚手架
- 确认 custodial(managed_signer,服务端持密钥)还是 non-custodial(wallet_signature,用户端签名)为首发模式。首发建议 **custodial + 严格 allowlist**,链路最短。
- 选定 Path B,建仓 `signer-service/`(独立服务,不进 Worker bundle)。
- 明确合规边界(见 §6)。

### 42.2 signer service 最小可用
> 详细接口契约见 [PHASE_42_2_SIGNER_API.md](./PHASE_42_2_SIGNER_API.md)(custodial 模式,已细化请求/响应/鉴权/错误码/SDK 映射)。

- 集成官方 SDK:`ClobClient(host, 137, signer, creds)`。
- 实现 `createOrDeriveApiKey()` 流程,缓存每用户 L2 creds。
- 暴露内部接口(对齐 Worker 现有调用):
  - `POST /orders` → `createOrder` + `postOrder(GTC)`;市价用 `createAndPostMarketOrder(FOK/FAK)`,带 `tickSize`/`negRisk`。
  - `GET /orders/:id`、`POST /orders/:id/cancel`、`GET /orders/open`。
  - `GET /portfolio/positions`(走 Data API)、`GET /portfolio/fills`。
- 校验入站签名头(沿用 Worker 的 `x-order-signature` envelope 作为「Worker↔signer」内部鉴权)。

### 42.3 链上资金前置
- USDC.e + CTF/Exchange `allowance` 检查与一次性授权流程。
- 充值地址下发(`user_trading_accounts.deposit_address_*` 已有列)与余额校验;余额/授权不足时 `/buy` 给出明确中文提示而非直接失败。

### 42.4 Worker 侧对齐(改 `order_gateway.ts`)
- `buildLiveOrderPayload`:补 `side(BUY/SELL)`、`order_type(GTC/FOK)`、`price/tick_size`、`neg_risk`;把 `signature_type` 从自造字符串映射成 `EOA/POLY_PROXY/POLY_GNOSIS_SAFE`。
- `normalizeLiveStatus`:对齐真实 CLOB 状态机(`live/matched/delayed/unmatched/cancelled` 等)。
- readiness:`getOrderGatewayReadiness` 增加「signer service 可达」「allowance ready」「L2 creds 就绪」三项,接进 `/healthz` 与 `/health`。
- 错误路径:区分「资金/授权不足」「签名失败」「CLOB 拒单」并各自给用户中文文案。

### 42.5 灰度上线
- 复用 `NEWBOT_LIVE_TRADING_TELEGRAM_IDS`:首发仅 1–2 个内部账户、单笔金额上限。
- 复用 `--require-ready` smoke + runbook,把新 readiness 项纳入放量前检查。
- 单笔限额、日限额、幂等(`idempotency_keys` 表已存在)接入 `/buy`。

## 5. 任务拆解(给排期)

1. [ ] 选型决策 + 合规确认(custodial/non-custodial、辖区 geoblock 策略)。
2. [ ] `signer-service` 工程初始化 + 官方 SDK 接通 testnet/小额 mainnet。
3. [ ] L1/L2 鉴权与 per-user creds 缓存。
4. [ ] 下单 / 撤单 / 查单 / 持仓 / 成交 五个内部接口 + 归一化。
5. [ ] allowance 检查与授权流程 + 余额校验。
6. [ ] Worker `order_gateway.ts` 字段与状态机对齐;readiness 扩展。
7. [ ] 限额 / 日限额 / 幂等接入 `/buy`、`/cancel`。
8. [ ] 测试:signer-service 单测 + Worker 侧 `webhook.phase42.test.ts`(沿用 in-memory `Env` + stub fetch)+ 真实小额 e2e 一次。
9. [ ] 文档:README「当前 Phase 42」段、LAUNCH_CHECKLIST live 段更新、新增 secret 文档。

## 6. 风险与合规(必须先拍板)

- **密钥托管**:custodial 模式下服务端持用户私钥是最大风险点 —— 加密存储(`encrypted_payload`,KMS/封套加密)、最小权限、审计日志、泄露应急预案缺一不可。
- **资金安全**:单笔/日限额、幂等、撤单兜底、对账(`trade_events` ↔ CLOB 实际成交)。
- **地区合规**:`user_trading_accounts.geoblock_*` 列已存在,需接入实际 geoblock 判定;Polymarket 对部分辖区(含美国)有访问限制,上线前确认目标用户合规。
- **审计**:所有 live 订单 `trade_events` + `builder_attributions` 已落库;补一条「资金/授权前置检查结果」入 payload。

## 7. 验收标准

- signer service 能用真实小额在 mainnet 成功下一单并成交,`orderID`/`transactionHashes` 可回查。
- Worker `/buy` 对 allowlist 内用户走真实下单,非 allowlist 仍回退模拟单(现有行为不回归)。
- `/cancel`、`/openorders`、`/positions`、`/fills` 返回真实 CLOB/Data API 数据,缓存回退语义保留。
- `/healthz` readiness 能如实反映 signer 可达、allowance、creds 状态;`--require-ready` smoke 在未就绪时阻断。
- `npm run typecheck && npm test` 全绿,新增 `webhook.phase42.test.ts` 覆盖真实下单/拒单/资金不足三条路径。
- README / LAUNCH_CHECKLIST / secret 文档同步更新。

## 8. 关键参考

- 官方 TS 客户端:`@polymarket/clob-client`(`/polymarket/clob-client`)。
- 官方 Python 客户端:`py-clob-client`。
- 鉴权:L1(EIP-712 建 key)→ L2(HMAC 头);签名类型 `EOA/POLY_PROXY/POLY_GNOSIS_SAFE`。
- 下单:`createOrder`+`postOrder(GTC/GTD)`、`createAndPostMarketOrder(FOK/FAK)`,需 `tickSize` 与 `negRisk`。
