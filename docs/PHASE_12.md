# Phase 12 复盘

这一步把 NewBot 从“有 open orders / positions / fills 读取”，推进到“开始具备本地缓存、分页，以及持仓浮动盈亏展示”的状态。

完成内容：

- portfolio / open orders 读取开始带本地缓存
  - `openorders`
  - `positions`
  - `fills`
  现在都会把远端返回缓存进 `market_cache`
  - 当远端暂时失败时，会优先回退到最近缓存，不会整块直接空掉
- `/openorders` 新增分页
  - 现在支持类似：`/openorders 2`
  - 会显示页码信息
  - 先按每页 2 条做基础分页
- `/fills` 新增分页
  - 现在支持类似：`/fills 2`
  - 会显示页码信息
  - 先按每页 2 条做基础分页
- `/positions` 开始展示更像真实交易面板的数据
  - 如果远端持仓里带了 `avgPrice` 和 `currentPrice`
  - 现在会直接展示浮动盈亏
  - 输出里会出现：
    - 均价
    - 浮动 +$ / -$
- portfolio 读路径更稳了
  - 远端在线时：读 live 数据并更新缓存
  - 远端失败时：优先读缓存
  - 连缓存也没有时：再回退到本地简化视图 / 空结果

自动化验证覆盖：

- `/openorders 2` 会按页返回后半部分 open orders
- `/positions` 在远端失败时会回退到缓存，并展示浮动盈亏
- `/fills 2` 会按页返回后半部分 fills
- 之前的 live buy / cancel / status sync / simulated fallback 全部继续通过

当前仍未覆盖：

- 可配置 page size
- 更正式的 cursor / next page token
- portfolio 缓存的主动刷新任务
- 更完整的 PnL 口径（已实现/未实现盈亏拆分）
- callback 按钮式分页

所以 Phase 12 的定位可以概括成：
“系统已经不只是能读远端交易数据了，而是开始具备交易面板常见的可用性增强：缓存、分页、浮盈亏展示，用户体验明显更像一个真实可用的交易机器人。”
