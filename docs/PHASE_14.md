# Phase 14 复盘

这一步把 NewBot 从“能在 Telegram 里翻页、点按钮撤 open orders”，推进到“按钮撤单之后，列表会原地刷新，而且能尽量保持用户所在页”的状态。

完成内容：

- open orders 撤单按钮开始带页码上下文
  - 现在撤单 callback 不只是带 `orderId`
  - 还会把当前页一起带上
  - 这样撤单完成后，系统知道应该回到哪一页继续展示
- callback 撤单后自动刷新 open orders
  - 之前点击 `撤单` 后，只会回一句“已取消”
  - 现在会在撤单成功后立刻重新拉一次 open orders
  - 然后直接把消息原地刷新成新的列表
- 如果当前页被撤空，会自动回退到上一页
  - 比如原来第 2 页只有 1 条单
  - 撤掉之后这页没内容了
  - 现在会自动回到第 1 页，而不是留在一个空页状态
- open orders 的 callback 交互更连贯了
  - 看第几页 → 点撤单 → 继续停留在合理页码
  - 不需要用户手动重新发 `/openorders`
- 默认兜底文案升级到 Phase 14
  - 明确告诉用户现在支持撤单后原地刷新列表

自动化验证覆盖：

- `/openorders 2` 返回的撤单按钮现在会带页码上下文
- `openorders_page:2` callback 仍然会原地 edit message，并保留带页码的撤单按钮
- `cancel_open_order:<orderId>:<page>` callback 会：
  - 先发撤单请求
  - 再刷新 open orders
  - 最后原地更新消息
- 当撤单后当前页为空时，会自动回退到上一页展示
- page 1 的普通 callback 撤单，也会刷新成新的 open orders 列表
- 之前已有的：
  - live buy
  - live cancel
  - live status sync
  - simulated fallback
  - portfolio 缓存 / 分页 / 浮盈亏
  - positions / fills callback 翻页
  全部继续通过

当前仍未覆盖：

- 更正式的 cursor / next page token
- 已实现盈亏 / 未实现盈亏拆分
- Builder Program 真正归因字段落库与生效校验
- 更接近生产级 Polymarket 官方协议签名
- callback 撤单后的 toast / 状态提示细化（比如“已撤 1 笔，列表已刷新”）

所以 Phase 14 的定位可以概括成：
“系统已经不只是能在 Telegram 里看和点，而是开始具备更像真实交易面板的列表维护能力：撤单后会自动刷新、页码会自动收敛，交互明显更顺。”
