# Phase 4 复盘

这一步把 NewBot 从“能点菜单、能看市场”，推进到“有绑定入口、有关键词搜索、有下单前入口占位”的状态。

完成内容：

- 新增 `/link`
  - 为用户生成账户绑定口令
  - 把会话写入 `user_account_sessions`
  - 先把接入入口和过期时间打通
- 新增 `/find <关键词>` / `/search <关键词>`
  - 拉取活跃市场列表
  - 做本地关键词匹配
  - 把结果写进 `market_cache`
- 市场概览和搜索结果里新增 `准备下单`
  - 先做成下单前确认流入口占位
  - 如果账户未绑定，会先引导去绑定
- 账户状态回复里新增 `开始绑定`
  - callback 后也能直接生成绑定口令
- 继续保持 callback 菜单刷新模式
  - `answerCallbackQuery`
  - `editMessageText`
- 保留 webhook 容错
  - Telegram 编辑失败时不让 Worker 500 崩掉

自动化验证覆盖：

- `/start` 欢迎词 + 菜单
- `/market` 市场概览 + 缓存
- `/find btc` 关键词搜索 + 缓存
- `/link` 绑定入口口令 + session 落库
- `trade_entry` 未绑定账户时的拦截引导
- callback 编辑失败时 webhook 仍返回 200

当前仍未覆盖：

- 真实绑定 portal / 钱包签名流程
- 市场详情页和分页搜索
- 真正的下单金额输入、确认、提交
- 更细的持仓 / 订单状态读取

所以 Phase 4 的定位可以概括成：
“入口链路更完整了，但真实交易动作还只是下一步骨架。”
