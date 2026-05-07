# Phase 15 复盘

这一步把 NewBot 从“能分页、能撤单、能刷新列表”，推进到“持仓页开始具备更像正式 portfolio 的盈亏口径拆分，并且文本指令开始支持 page token”的状态。

完成内容：

- positions 开始拆分已实现 / 未实现盈亏
  - 之前持仓页只有一条总浮动逻辑
  - 现在会分别展示：
    - 已实现盈亏
    - 未实现盈亏
  - 如果远端直接给了 `realizedPnl` / `unrealizedPnl`
    - 就优先用远端值
  - 如果没有 `unrealizedPnl`
    - 就继续用 `avgPrice/currentPrice` 兜底推导
- 单条持仓行也更完整了
  - 现在不只是显示均价和浮动
  - 还会在有数据时展示：
    - 未实现盈亏
    - 已实现盈亏
- positions 支持 page token 风格输入
  - 除了 `/positions 2`
  - 现在也支持 `/positions p2`
  - 这样后面往更正式的 cursor / token 体系过渡会更顺
- positions 页开始显示分页 token
  - 现在持仓页会显示：
    - 当前分页游标，比如 `p2`
    - 如果还有下一页，也会直接提示 `下一页 token`
- 默认兜底文案升级到 Phase 15
  - 明确告诉用户现在支持已实现/未实现盈亏和分页 token

自动化验证覆盖：

- `/positions` 缓存回退场景下，会展示已实现和未实现盈亏
- `/positions 2` 仍然能正确分页，并显示新的 PnL 拆分与分页游标
- `/positions p2` 现在能正确解析为第 2 页
- 如果远端给了 `realizedPnl`，汇总会正确展示已实现盈亏
- 如果远端没给 `unrealizedPnl`，仍会用 `avgPrice/currentPrice` 推导未实现盈亏
- 之前已有的：
  - live buy
  - live cancel
  - live status sync
  - simulated fallback
  - open orders callback 撤单 + 自动刷新
  - fills / positions / open orders 分页
  全部继续通过

当前仍未覆盖：

- 更正式的 cursor / next page token（目前还是轻量 token，不是真正远端 cursor）
- Builder Program 真正归因字段落库与生效校验
- 更接近生产级 Polymarket 官方协议签名
- callback 撤单后的 toast / 状态提示细化

所以 Phase 15 的定位可以概括成：
“系统已经不只是会列出持仓，而是开始具备更像正式 portfolio 面板的盈亏表达：已实现和未实现开始分开讲，分页也开始向 token 化过渡。”
