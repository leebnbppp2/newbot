# Phase 17 复盘

这一步把 NewBot 从“Builder attribution 已经真正接进 live 下单链路”，推进到“live / cancel 请求开始带更像生产协议的 canonical 签名头，并且本地会保留 signature envelope 供排查和对账”的状态。

完成内容：

- live 下单签名头更正式了
  - 之前主要是一个 `x-order-signature`
  - 现在如果配置了 signing secret，live 下单请求会一起带上：
    - `x-order-signature`
    - `x-order-body-sha256`
    - `x-order-signature-input`
    - `x-order-protocol-version`
    - `x-order-timestamp-ms`
    - `x-order-nonce`
- canonical 签名输入开始独立成 envelope
  - 现在签名不再只是“直接 HMAC 整个 JSON”然后发出去
  - 会先生成：
    - body sha256
    - timestamp
    - nonce
    - protocol version
    - canonical signature input string
  - 再对 canonical signature input 做签名
- signature envelope 会写进 trade event payload
  - live 下单成功后，`trade_events.payload_json` 里现在除了 builder attribution 之外
  - 还会带一个 `signature_envelope`
  - 里面会保留：
    - protocol version
    - body sha256
    - timestamp
    - nonce
    - signature input
    - signature
  - 所以后面排查“这笔单到底是怎么签出来的”时，会比之前容易很多
- cancel 请求也开始走同一套签名头
  - 如果有 signing secret
  - `/cancel <orderId>` 发出去的 live cancel request 现在也会带同一套 canonical signature headers
  - 不再只有 buy 路径是生产级签名风格
- 协议版本开始显式化
  - 现在会通过 `x-order-protocol-version` 和 envelope 中的 `protocolVersion`
  - 明确标识当前走的是 `polymarket_clob_v2`

自动化验证覆盖：

- live buy 请求现在会验证请求头里确实带上：
  - `x-order-body-sha256`
  - `x-order-signature-input`
  - `x-order-protocol-version`
  - `x-order-timestamp-ms`
  - `x-order-nonce`
- live buy 成功后，会验证：
  - `trade_events.payload_json` 里带有 `signature_envelope`
  - 并且带有 `polymarket_clob_v2`
- live cancel 请求现在也会验证：
  - `x-order-signature`
  - `x-order-body-sha256`
  - `x-order-signature-input`
  - `x-order-protocol-version`
- 之前已有的：
  - Builder attribution 落库
  - live buy
  - live cancel
  - live status sync
  - simulated fallback
  - open orders callback 撤单 + 自动刷新
  - positions PnL 拆分
  全部继续通过

当前仍未覆盖：

- builder attribution 的远端回执核验 / 对账回查
- 更正式的 builder key 有效性探测与失败告警
- 上线前灰度 / 观测 / 提示细化

所以 Phase 17 的定位可以概括成：
“下单和撤单已经不只是带一个签名字段，而是开始具备更像真实生产协议的 canonical signature 结构；同时本地也保留了足够的 signature envelope，方便后面做排查、审计和对账。”
