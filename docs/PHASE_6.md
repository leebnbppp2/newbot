# Phase 6 复盘

这一步把 NewBot 从“有 portal 骨架、有市场详情、有下单确认占位”，推进到“portal 可以真正完成绑定、Telegram 里能看到已绑定账户信息、还能先走一遍模拟下单和订单/仓位查看”的状态。

完成内容：

- portal 真正可提交
  - 新增 `POST /portal/link/:token/complete`
  - 会校验 `user_account_sessions`
  - 提交后会把账户状态写入 `user_trading_accounts`
  - 同时把当前链接会话标记为 `linked`
- `/account` 变得更像真实账户面板
  - 已绑定时会显示：
    - 账户备注
    - 接入方式
    - signer 地址缩略
    - funder 地址缩略
- `/detail <关键词>` 补了更多字段
  - 现在会尽量展示 slug
  - 会把 outcome / price 一起带出来
  - 给用户更明确的下一步下单格式
- `/buy` 进入 Phase 6 模拟下单模式
  - `/buy 50` 还可以继续当金额入口占位
  - 新增更完整格式：`/buy btc yes 50`
  - 已绑定账户时会：
    - 找最匹配市场
    - 匹配 Yes / No outcome
    - 写入 `trade_events`
    - 返回模拟订单号
- 新增 `/orders`
  - 读取最近订单记录
  - 用于回看最近几笔模拟单
- 新增 `/positions`
  - 先把已有订单整理成模拟仓位视图
  - 给后面接真实持仓接口留好入口

自动化验证覆盖：

- portal 页面渲染继续通过
- portal 表单提交后能真正把账户写入 `user_trading_accounts`
- `/account` 能展示 richer 账户信息
- `/buy btc yes 50` 能写入 `trade_events`
- `/orders` 能返回最近订单列表
- 之前的 `/market`、`/find`、`/detail`、`/link`、callback 容错都继续通过

当前仍未覆盖：

- 真实钱包签名验证
- 真实 Polymarket 下单 API 提交
- 真实持仓 / 余额 / 未成交订单回查
- 更完整的多步交互式下单确认流

所以 Phase 6 的定位可以概括成：
“绑定状态已经能真正落库，交易链路也能先走通一版模拟订单闭环，但真实签名和真实下单还没接到生产级。”
