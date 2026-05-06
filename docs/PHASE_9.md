# Phase 9 复盘

这一步把 NewBot 从“有 signed live payload 骨架”，推进到“开始区分更像真实 CLOB 协议的签名模式，并且 `/orders` 能对 live 订单做状态回查准备”的状态。

完成内容：

- order gateway 升级为 auth-mode aware
  - `managed_signer` 不再只是一句描述
  - `wallet_signature` 也开始走独立的签名类型分支
- live payload 的 `signature_type` 更贴近协议层
  - `managed_signer` → `clob_delegate`
  - `wallet_signature` → `clob_wallet`
- live request header 也开始带协议相关上下文
  - `x-auth-mode`
  - `x-signature-type`
- 签名逻辑从“通用 HMAC”再往前推进一步
  - 现在签名时会把 `auth_mode` 混进签名 secret 的导出过程
  - 先把两种签名路径在代码结构上拆开
- `/orders` 新增 live 状态回查准备
  - 如果订单事件是 `live_*` 且有 `order_id`
  - 并且环境里配置了 live order API
  - 现在会额外请求：`GET /orders/:orderId`
  - 再把返回状态映射成：
    - `live_submitted`
    - `live_matched`
    - `live_cancelled`
- 订单列表文案也更适合排查 live 订单
  - 现在会把 `order_id` 一起展示出来

自动化验证覆盖：

- `managed_signer` live 下单时，payload 会使用 `clob_delegate`
- `wallet_signature` live 下单时，payload 会使用 `clob_wallet`
- `/orders` 在有 live API 配置时，会对 live 订单做状态刷新
- 刷新后的订单状态会展示在 Telegram 回复里

当前仍未覆盖：

- 真实 Polymarket/CLOB 官方签名字段与 canonical serialization
- 真实 EIP-712 / 钱包 challenge 签名
- 撤单接口
- 真正的 live 订单落库状态同步回写
- 真实持仓、余额、未成交订单同步

所以 Phase 9 的定位可以概括成：
“系统已经从单纯 signed payload，推进到按 auth mode 区分协议签名路线，并且开始具备 live 订单状态回查能力，但离官方交易协议级别的签名细节还差最后一段。”
