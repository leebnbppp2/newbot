# Phase 11 复盘

这一步把 NewBot 从“有 live 订单生命周期骨架”，推进到“开始具备 live 未成交订单、远端持仓和成交记录读取能力”的状态。

完成内容：

- 新增 `/openorders`
  - 会请求远端：`GET /orders/open?bot_id=...&telegram_user_id=...`
  - 返回当前未成交订单列表
  - 现在 Telegram 里可以直接看到：
    - orderId
    - market slug
    - outcome
    - amount
    - status
- `/positions` 升级为双路径
  - 如果远端 portfolio API 有返回
    - 优先展示真实远端持仓
  - 如果远端没配置 / 没数据
    - 继续回退到本地 trade_events 推导的简化持仓视图
- 新增 `/fills`
  - 会请求远端：`GET /portfolio/fills?bot_id=...&telegram_user_id=...`
  - 返回最近成交记录
  - Telegram 里可以直接看到：
    - market slug
    - buy / sell
    - outcome
    - amount
    - price
- 用户态读接口开始更完整
  - 现在除了 `/orders` 和 `/cancel`
  - 还具备：
    - `/openorders`
    - `/positions`
    - `/fills`
  - 这意味着用户已经能开始看“订单、未成交、持仓、成交”这四块最基本的数据面板

自动化验证覆盖：

- `/openorders` 能返回远端未成交订单列表
- `/positions` 在有远端 portfolio 数据时优先返回真实持仓
- `/fills` 能返回远端成交记录
- 之前的 live buy / cancel / status sync / simulated fallback 全部继续通过

当前仍未覆盖：

- 远端 portfolio 数据回写本地缓存
- PnL / 盈亏展示
- 分页与更多历史记录
- callback 按钮式 open order 管理
- 批量撤单

所以 Phase 11 的定位可以概括成：
“系统已经不只是会下单和撤单了，而是开始具备一个交易机器人最基础的数据读取面：未成交、持仓、成交都能看，离真正可用的交易面板又近了一步。”
