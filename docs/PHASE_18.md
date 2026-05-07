# Phase 18 收尾

这一步把 NewBot 从“主线功能基本齐了”推进到“更适合上线前灰度、观察和排查”的状态。

完成内容：

- `/healthz` 开始直接暴露 readiness
  - 现在不只是 `{ ok, version }`
  - 还会把这几个关键上线状态一起返回：
    - live order API 是否完整可用
    - canonical signing 是否已启用
    - Builder Program 当前是 `ready / partial / disabled`
    - 当前 warning 列表
  - 所以后面你看部署环境时，不用再靠猜配置有没有缺口

- portfolio / open orders / fills 会明确告诉你数据是实时还是缓存
  - 如果远端接口正常，消息里会直接标记 `数据来源：实时`
  - 如果远端暂时失败但本地还有缓存，会直接提示：
    - 远端订单/持仓/成交暂时拉取失败
    - 先展示上次缓存
  - 这样用户和你自己都能第一眼看出“这条数据现在到底新不新”

- callback 开始带简短 toast 状态提示
  - 翻页时会提示当前切到哪一页
  - 进入市场 / 账户 / 绑定入口 / 下单入口时会给一个短提示
  - 从 open orders 里直接撤单后，也会有简短确认
  - 这样交互上不再只是静默 edit message，用户会更确定自己刚刚点到了什么

- Builder / signing 的上线前告警更集中
  - 如果 live API 缺配置，会在 readiness warning 里直接体现
  - 如果只配了 builder tag 或只配了 builder api key，也会明确标成 partial
  - 如果 live API 配了但 signing secret 没配，也会直接给 warning

自动化验证覆盖：

- `/healthz` 会验证 readiness 结构和 warning 输出
- open orders callback 会验证 answerCallbackQuery 里带上 toast 文案
- positions 缓存回退时，会验证消息正文直接提示“远端失败，先看缓存”
- 之前已有的：
  - live buy
  - live cancel
  - live status sync
  - builder attribution 落库
  - canonical signature headers / envelope
  - open orders / positions / fills 分页
  全部继续通过

所以 Phase 18 的定位可以概括成：
“主线功能不再只是能跑，而是开始把上线前最容易踩坑的配置状态、缓存回退状态和 callback 交互反馈都补齐了。”
