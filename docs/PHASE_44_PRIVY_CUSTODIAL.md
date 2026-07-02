# Phase 44 — Privy 托管签名(方案 C)真实交易上线手册

> 状态:**实现中**。G1–G4 已完成并测试;G5(`/buy` 接入真实 CLOB)、G6(开通/readiness)、G7(限额/幂等)代码就绪/推进中;G8(退役旧 signer + 真实小额 e2e)待外部凭证与资金。
> 本方案**取代** Phase 42 的 custodial signer-service 设计;Phase 43 的非托管"每单网页签名(B)"为日后第二种模式。

## 1. 架构(Path A:Worker 进程内直连)

```
Telegram → Worker(CF)─┬─ @privy-io/node ──▶ Privy MPC/TEE(持私钥 + policy 引擎,Worker 只持授权密钥)
                      ├─ @polymarket/clob-client(viem 原生)──▶ CLOB REST(EIP-712 sigType=2 订单,链下撮合,免 gas)
                      └─ builder-relayer-client ──────────────▶ Relayer(仅链上:部署 Safe / 授权 / CTF,relayer 代付 gas)
```

- 每个 Telegram 用户:一把 **Privy 嵌入式钱包(EOA)** 控制一个 **Gnosis Safe**(持仓 funder),订单按 **sigType=2(POLY_GNOSIS_SAFE)** 签名。
- **私钥永不进 Worker**:在 Privy enclave 内;Worker 只持 P-256 授权密钥 + policy(合约白名单/限额)实现"能交易、偷不走"。
- **变现**:每笔订单挂 builder code 路由,赚取 Builder 分成。
- **一键 `/buy`**:服务端代签,用户无需网页/钱包弹窗。

## 2. 需要配置的 Secret / 环境变量

| 变量 | 必需? | 说明 |
|------|--------|------|
| `NEWBOT_TRADING_MODE` | 上线时 `=live` | 总开关;非 `live` 一律模拟单(安全默认) |
| `NEWBOT_LIVE_TRADING_TELEGRAM_IDS` | 灰度建议 | 真实交易用户 allowlist(CSV);首发只放 1–2 内部账户 |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | ✅ | Privy app 凭证(Dashboard 获取) |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | ✅ | P-256 授权私钥(后端控制钱包用);公钥作为 wallet owner |
| `PRIVY_AUTHORIZATION_PUBLIC_KEY` | 建议 | 授权公钥(作为 wallet/policy owner) |
| `PRIVY_TRADING_POLICY_ID` | 可选 | 复用已建 policy 的 id(否则按需创建) |
| `NEWBOT_CREDS_ENCRYPTION_KEY` | ✅ | AES-GCM 主密钥,加密用户 L2 creds |
| `POLYMARKET_CLOB_HOST` | ✅ | `https://clob.polymarket.com` |
| `POLYMARKET_RELAYER_URL` | ✅(开通用) | Builder Relayer URL(Safe 部署/授权) |
| `POLYGON_RPC_URL` | ✅ | Polygon RPC(viem 签名/链上) |
| `POLYMARKET_BUILDER_API_KEY` / `_API_SECRET` / `_PASSPHRASE` | ✅(变现) | Builder 凭证;缺失则无分成归因 |
| `POLYMARKET_BUILDER_TAG` | 建议 | Builder 标签 |
| `NEWBOT_PER_TRADE_MAX_USDC` / `NEWBOT_DAILY_MAX_USDC` | 建议 | 应用层单笔/日限额(纵深防御) |

设置方式:本地 `.dev.vars`(gitignore);线上 `wrangler secret put <NAME>`。

## 3. 上线前必须由人准备的外部前置(代码无法替代)

1. **Privy app**:注册 → 建 app → 取 App ID/Secret → 生成 P-256 授权密钥(`generateP256KeyPair`,公钥设为 owner,私钥入 secret)→ 链设 Polygon(137)。
2. **Polymarket Builder 凭证**:从 Builder program 申请(变现来源)。
3. **资金**:首发给内部 Safe 充少量 USDC 做真实小额 e2e(gas 由 relayer 代付,无需 POL)。
4. **待核实**:抵押币种 **USDC.e vs pUSD/原生 USDC**(迁移期,授权错合约=全拒单)。

## 4. 数据库迁移

`npm run d1:apply:0002`(追加 `0002_privy_custodial.sql`;不幂等,勿重复 apply)。

## 5. 上线步骤(灰度)

1. 配齐 §2 的 secret;`NEWBOT_LIVE_TRADING_TELEGRAM_IDS` 只放内部 id。
2. `NEWBOT_TRADING_MODE` 暂留非 `live` 验证健康。
3. `/health`、`/healthz` 检查 readiness:`clobLive / privyConfigured / credsEncryption / builderAttribution` 均就绪、无 warning。
4. 内部账户走开通(provision Privy 钱包 + Safe + 授权)→ 充小额 USDC。
5. `NEWBOT_TRADING_MODE=live` → 内部账户 `/buy <市场> yes <金额> <价格>` 真实成交一笔 → `/orders` 验证 live → `/cancel` 验证 → `/positions`/`/fills` 反映真实。
6. policy 验证:尝试非白名单合约 / 超额 / 提现到非登记地址应被 enclave 拒。
7. 逐步放量 allowlist。

回退:`NEWBOT_TRADING_MODE` 改回非 `live` → 全部回退模拟单。

## 6. 关键代码落点

- `src/lib/privy_signer.ts` — Privy 钱包/policy 开通 + viem WalletClient(ClobSigner)
- `src/lib/polymarket_clob.ts` — ClobClient(sigType=2 + builder)、L2 creds、下单
- `src/lib/creds_crypto.ts` — L2 creds AES-GCM 加解密(fail-closed)
- `src/lib/order_gateway.ts` — `executeBuyOrder` Path A 路由 + readiness
- `src/lib/trade_limits.ts` — 应用层限额
- `src/db/{trading_credentials,idempotency,users,trade_events}.ts` — 持久化
- `migrations/0002_privy_custodial.sql` — schema

## 7. 安全边界

- 私钥在 Privy enclave;Worker 仅持授权密钥 + 加密后的 L2 creds(D1)。
- "偷不走":Privy policy(合约白名单 + 后续 calldata 级 approve-only/提现白名单)+ 应用层限额 + allowlist。
- 残留风险:授权密钥泄露 + policy 配置不当仍可能被刷单 → 首发限内部 + 限额封顶;放量前复审(毕业条件)。
