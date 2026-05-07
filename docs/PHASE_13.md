# Phase 13 复盘

这一步把 NewBot 从“portfolio 能看、能分页、能展示浮盈亏”，推进到“用户可以直接在 Telegram 里原地翻页，并且从 open orders 里直接点按钮撤单”的状态。

完成内容：

- open orders 开始带 callback 操作按钮
  - 每条 open order 现在都会带一个 `撤单` 按钮
  - 用户不需要再手动复制订单号去发 `/cancel <orderId>`
  - 如果本地 `trade_events` 里刚好有对应订单号，撤单后的状态也会顺手回写
- open orders 支持 callback 翻页
  - `/openorders` 的消息现在可以直接点 `上一页 / 下一页`
  - 翻页是原地 edit message，不会不断刷新出一串新消息
- positions 进入更完整的 portfolio 视图
  - `/positions` 现在支持 `/positions 2` 这种分页
  - 会显示：
    - 当前页 / 总页数
    - 总敞口
    - 总浮动盈亏
  - 所以持仓页已经不只是单条列表，而更像一个真的 portfolio summary
- positions 支持 callback 翻页
  - 用户现在也可以直接点 `上一页 / 下一页` 看不同持仓页
- fills 支持 callback 翻页
  - `/fills` 仍然保留文本分页
  - 同时消息里也会带 `上一页 / 下一页` 按钮
- 默认兜底文案升级到 Phase 13
  - 明确告诉用户现在已经可以直接点分页和撤单按钮继续走

自动化验证覆盖：

- `/openorders 2` 会返回正确页的数据，并带 callback 撤单 / 翻页按钮
- `openorders_page:2` callback 会原地 edit message，展示第 2 页数据
- `cancel_open_order:<orderId>` callback 会直接发撤单请求，并返回取消结果
- `/positions` 在远端失败时会继续走缓存，并展示总敞口 / 总浮动盈亏
- `/positions 2` 会返回正确页的数据，并带 callback 翻页按钮
- 之前已有的：
  - live buy
  - live cancel
  - live status sync
  - simulated fallback
  - fills / open orders 文本分页
  全部继续通过

当前仍未覆盖：

- callback 撤单后的 open orders 自动 refresh 当前页
- 更正式的 cursor / next page token
- 已实现盈亏 / 未实现盈亏拆分
- Builder Program 真正归因字段落库与生效校验
- 更接近生产级 Polymarket 官方协议签名

所以 Phase 13 的定位可以概括成：
“系统已经不只是一个会回文字的交易机器人，而是开始具备更像真实交易面板的 Telegram 交互层：能原地翻页、能直接点按钮撤单、能在持仓页先看到 portfolio summary。”
