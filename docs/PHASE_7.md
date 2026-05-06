# Phase 7 复盘

这一步不是直接把真实 Polymarket 生产下单完全打通，而是先把“真实下单 API 的接入层”准备好，让系统从现在开始具备：有配置就走 live request，没配置就自动回退到模拟单的能力。

完成内容：

- 新增 Phase 7 order gateway
  - 新增 `src/lib/order_gateway.ts`
  - 统一处理 `/buy` 的执行层
  - 现在会先判断环境里有没有真实下单 API 配置
- `/buy <关键词> <yes|no> <金额>` 现在分两种路径
  - 有 `POLYMARKET_ORDER_API_BASE` + `POLYMARKET_ORDER_API_KEY`
    - 走 live order request
    - 向 `/orders` 发出真实下单请求
    - 把返回的 `orderId` / 状态写进 `trade_events`
  - 没有配置
    - 自动回退到模拟单
    - 继续保证当前链路可用，不会因为缺配置直接卡死
- 下单回执文案升级
  - live 模式会明确告诉用户：真实下单请求已经发出
  - simulated 模式会明确告诉用户：还没接入真实下单 API，所以这笔先按模拟单记录
- `trade_events` 现在开始记录更明确的执行模式信息
  - `live_submitted`
  - `simulated_submitted`
  - payload 里会带 mode / detail
- 为真实下单预留环境变量
  - `POLYMARKET_ORDER_API_BASE`
  - `POLYMARKET_ORDER_API_KEY`

自动化验证覆盖：

- 无真实 API 配置时，`/buy btc yes 50` 会回退为模拟单
- 有真实 API 配置时，`/buy btc yes 50` 会向 order API 发 POST 请求
- live request 返回的 `orderId` / 状态会落到 `trade_events`
- 之前的 `/account`、`/orders`、`/positions`、portal 绑定链路继续通过

当前仍未覆盖：

- 真实 Polymarket 签名生成
- builder / CLOB 规范参数拼装
- 真实余额校验、成交回执、撤单
- 真实未成交订单与持仓回查

所以 Phase 7 的定位可以概括成：
“真实下单的接入层已经搭出来了，系统现在能区分 live 和 simulated 两条执行路径，但真正的生产签名和交易所细节还要下一阶段继续补。”
