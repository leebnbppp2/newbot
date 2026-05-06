# Phase 3 复盘

这一步把 NewBot 从“能对话”推进到“能点菜单 + 能先看市场”的状态。

完成内容：

- 主菜单新增 `看市场`
- 支持 `/market` / `/markets`
- 支持 callback_query：
  - `market_overview`
  - `account_status`
  - `getting_started`
- callback 触发后，不再只是回一条新消息，而是：
  - 先 `answerCallbackQuery`
  - 再 `editMessageText` 直接刷新原菜单消息
- 新增市场概览读取层：
  - 从 Polymarket Gamma API 拉 3 个活跃市场
  - 写入 `market_cache`
  - 短 TTL 缓存，减少重复请求
- 对话持久化继续保留：
  - 文本消息记录为普通 user/assistant turn
  - callback 记录为 `[callback] xxx`

自动化验证：

- `/start` 欢迎词 + 菜单测试
- `/market` 会拉市场并写缓存
- `account_status` callback 会 answer + edit

当前仍未覆盖：

- 更细的市场搜索/筛选
- callback 分页和多层菜单
- 真实账户绑定入口
- 下单前确认流
- 更完整的异常回退和管理日志

所以 Phase 3 的定位可以概括成：
“菜单已可点，市场入口已接通，但交易主流程还没开始。”
