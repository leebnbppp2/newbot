# Phase 16 复盘

这一步把 NewBot 从“已经具备比较像样的 Telegram 交易面板”，推进到“Builder Program 归因真正进入生产下单链路，并且开始有独立落库与校验痕迹”的状态。

完成内容：

- Builder Program 正式接进 live 下单链路
  - 之前只有 `builder_tag` 骨架
  - 现在如果环境里提供：
    - `POLYMARKET_BUILDER_TAG`
    - `POLYMARKET_BUILDER_API_KEY`
  - live 下单 payload 会真正带上：
    - `builder_tag`
    - `builder_api_key`
    - `builder_api_key_hint`
- builder attribution 校验结果会进入订单 payload
  - live 下单的 detail / trade event payload 里现在会附带：
    - attribution 是否 active
    - builder tag
    - builder api key hint
    - attribution mode
  - 所以后面排查“这笔单到底有没有带 builder 归因”时，不用纯靠猜
- builder_attributions 开始独立落库
  - live 下单成功后，如果 builder attribution 存在
  - 现在会往 `builder_attributions` 表写一条记录
  - 当前落库内容包括：
    - telegram_user_id
    - bot_id
    - trade_event_id
    - builder_api_key_hint
    - order_id
    - amount_usdc
- trade event 和 builder attribution 开始真正关联
  - `createTradeEvent` 现在会返回 `last_row_id`
  - 这样 builder attribution 可以和对应的 trade_event_id 连起来
  - 后面做收益归因和对账时，会比之前顺很多
- README / 配置说明补上 builder api key
  - 现在文档里已经明确写了需要提供 `POLYMARKET_BUILDER_API_KEY`

自动化验证覆盖：

- live buy 请求现在会验证 payload 里确实带上：
  - `builder_tag`
  - `builder_api_key`
  - `builder_api_key_hint`
- live buy 成功后，会验证：
  - `builder_attributions` 表里新增一条记录
  - `trade_event_id` 能正确关联到刚创建的 trade event
  - `trade_events.payload_json` 里带有 builder attribution 校验结果
- 之前已有的：
  - live buy
  - live cancel
  - live status sync
  - simulated fallback
  - open orders callback 撤单 + 自动刷新
  - positions 已实现/未实现盈亏拆分
  全部继续通过

当前仍未覆盖：

- 更接近生产级 Polymarket 官方协议签名
- builder attribution 的远端回执核验 / 对账回查
- 更正式的 builder key 有效性探测与失败告警
- callback toast / 状态提示细化

所以 Phase 16 的定位可以概括成：
“Builder Program 已经不再只是 payload 里一个装饰性的 tag，而是开始真正进入 live 下单链路、订单明细和独立归因表，为后面的正式收益归因和生产对账打基础。”
