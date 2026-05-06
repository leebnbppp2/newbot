# Phase 8 复盘

这一步把 NewBot 从“已经能区分 live / simulated 下单路径”，推进到“live 路径已经具备 signed payload 结构和 builder 元信息准备”的状态。

完成内容：

- order gateway 升级为 signed live payload prep
  - `src/lib/order_gateway.ts` 现在不只是简单转发 `/orders`
  - 在 live 模式下会先构造一份更像真实交易接口会需要的 payload
- live 下单 payload 新增关键字段
  - `client_order_id`
  - `timestamp_ms`
  - `nonce`
  - `builder_tag`
  - `signature_type`
- 支持 live request 签名头
  - 新增可选环境变量：
    - `POLYMARKET_ORDER_SIGNING_SECRET`
    - `POLYMARKET_BUILDER_TAG`
  - 如果提供 signing secret，就会对 payload 做 HMAC-SHA256
  - 并写入请求头：`x-order-signature`
- live / simulated 双路径继续保留
  - 有 live config：发真实请求
  - 无 live config：自动回退模拟单
- `trade_events` 里的 live 事件现在能保留更多执行细节
  - payload 里会带 request 元数据
  - 也会记录这次是不是 signed request

自动化验证覆盖：

- 无 live API 配置时，仍会回退模拟单
- 有 live API 配置时，会向 `/orders` 发真实请求
- live payload 会带：
  - `client_order_id`
  - `timestamp_ms`
  - `nonce`
  - `builder_tag`
- 如果有 signing secret，请求头会带 `x-order-signature`

当前仍未覆盖：

- 真实 Polymarket / CLOB 官方签名规范
- 真实 EIP-712 或钱包签名挑战
- 真实余额、成交、撤单、未成交订单同步
- 用户凭证加密后的真实签名材料解密与使用

所以 Phase 8 的定位可以概括成：
“真实下单请求已经不再是裸 POST，而是开始具备 signed payload、nonce、timestamp、builder tag 这些生产化接入前必需的骨架，但距离真正的交易所规范签名还差最后一层协议细节。”
