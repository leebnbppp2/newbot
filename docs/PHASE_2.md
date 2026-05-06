# Phase 2 复盘

本阶段把 Phase 1 的纯 echo webhook，推进成一个更像产品入口的最小可用对话层：

- `/start` / `/menu` 改成中文欢迎词
- 追加主菜单 inline keyboard
- `/account` / `/status` 会读取 `user_trading_accounts`，返回当前是否已绑定
- 每次收到 Telegram 消息时，会先把 `users` 做 upsert
- 同时把 user / assistant 双向文本都写入 `conversations`

为了保证后续演进更稳，这次先补了自动化测试：

- 覆盖 `/start` 欢迎词 + 菜单行为
- 覆盖 `/account` 未绑定账户提示
- 覆盖 `users` / `conversations` 落库副作用

当前还没做的部分：

- 真正的市场查询入口
- callback_query 菜单交互
- 账户绑定链路
- 风控 / 幂等 / 管理日志

所以 Phase 2 现在更准确地说，是“对话入口 + 基础状态持久化”已经落好，下一步可以直接往市场查询和账户接入继续加。
