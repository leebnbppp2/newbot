# Phase 5 复盘

这一步把 NewBot 从“有入口、有搜索、有绑定口令”，推进到“有 portal 骨架、有市场详情、有下单确认占位”的状态。

完成内容：

- 新增 `GET /portal/link/:token`
  - 会读取 `user_account_sessions`
  - 对合法会话返回一个简洁的 HTML portal 骨架
  - 页面会展示口令、有效期，以及 managed signer 下一步说明
- 新增 `/detail <关键词>`
  - 从活跃市场里找最匹配的一条
  - 先展示单市场详情占位
  - 引导用户继续发 `/buy 50`
- 新增 `/buy <金额>`
  - 已绑定账户：返回下单确认占位
  - 未绑定账户：先引导绑定
- 交易相关回复更像真实流程：
  - 市场概览 / 搜索结果可以引导到下单入口
  - 市场详情可以引导到金额输入
- 继续保留 callback 刷新与 webhook 容错

自动化验证覆盖：

- portal 路由：合法 token 能返回 HTML 页面
- `/detail btc` 能返回单市场详情占位
- `/buy 50` 在已绑定账户时能返回确认占位
- 之前的 `/market`、`/find`、`/link`、`trade_entry`、callback 容错都继续通过

当前仍未覆盖：

- 真正的 portal 提交动作
- 钱包签名 / managed signer 实际接入
- 市场详情里的真实 outcome / price / token id
- 最终下单 API 提交
- 持仓和订单回查

所以 Phase 5 的定位可以概括成：
“真实交易的页面入口和确认入口都搭出来了，但真正的账户授权和下单执行还没接上。”
