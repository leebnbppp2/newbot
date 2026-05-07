# Phase 10 复盘

这一步把 NewBot 从“有 live 状态回查准备”，推进到“已经能撤 live 单，并且 `/orders` 的 live 状态刷新会回写到本地记录”的状态。

完成内容：

- 新增 live cancel 流
  - 现在支持：`/cancel <orderId>`
  - 对 live 订单会请求：`POST /orders/:orderId/cancel`
  - 返回结果后会把本地 `trade_events` 更新成最新状态
- `/orders` 的 live 状态刷新不再只是临时展示
  - 之前只是把 live 状态拉回来后临时显示给用户
  - 现在会进一步把刷新结果回写进 `trade_events`
  - 这样本地下次再读订单时，就不是旧状态了
- `trade_events` helper 补齐了真实同步所需能力
  - 新增按 `order_id` 查询
  - 新增更新状态 / payload 的方法
  - 让 live 状态同步和撤单都有落库动作
- cancel / sync 返回内容更适合后续扩展
  - cancel 会保留 previous payload + cancel result
  - status sync 会保留 previous payload + live status sync detail
  - 方便后续继续接正式回执结构

自动化验证覆盖：

- `/cancel live-ord-123` 会调用 live cancel API
- cancel 完成后 `trade_events.status` 会更新为 `live_cancelled`
- `/orders` 刷新 live 状态后，会把 `live_matched` 之类的新状态回写到本地记录
- 之前的 managed signer / wallet signature / live payload / simulated fallback 全部继续通过

当前仍未覆盖：

- 真实交易所规范的撤单签名细节
- 批量状态同步
- 未成交订单列表独立接口
- 余额 / 持仓 / 成交历史同步
- callback 按钮式取消单

所以 Phase 10 的定位可以概括成：
“系统已经从只会发 live 订单，推进到能撤单、能把远端 live 状态同步回本地，真正开始具备一个最小可用的订单生命周期骨架。”
