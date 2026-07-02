/**
 * Phase 17 reply builders.
 */
import type { SmokeReportMetrics, SmokeReportRun } from '../db/cron_runs';
import type { TradeEventRow } from '../db/trade_events';
import type { TradingAccountRow } from '../db/users';
import type { OrderGatewayReadiness, RemoteDataSource } from '../lib/order_gateway';

export interface TelegramMenuMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface BotReply {
  text: string;
  replyMarkup?: TelegramMenuMarkup;
}

export interface MarketOutcome {
  name: string;
  price?: number;
  tokenId?: string;
}

export interface MarketItem {
  question: string;
  volume: number;
  endDate?: string;
  /** Polymarket gamma numeric market id — short + stable, used as the buy-button callback key. */
  id?: string;
  slug?: string;
  outcomes?: MarketOutcome[];
}

export interface RemoteOpenOrder {
  orderId: string;
  marketSlug: string;
  outcome: string;
  amountUsdc: number;
  status: string;
}

export interface RemotePosition {
  marketSlug: string;
  outcome: string;
  sizeUsdc: number;
  avgPrice?: number;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
}

export interface RemoteFill {
  marketSlug: string;
  outcome: string;
  amountUsdc: number;
  price?: number;
  side: string;
}

/** A held on-chain position the user can sell (from the deposit wallet, via the data API). */
export interface SellablePosition {
  tokenId: string;
  title: string;
  outcome: string;
  size: number;
  curPrice: number;
  slug?: string | null;
  /** Cost basis per share (feed `avgPrice`, or reconstructed from local BUY history). */
  avgPrice?: number | null;
  /** Whole-position unrealized P&L in USDC, straight from the data-API feed when available. */
  cashPnl?: number | null;
  /** Whole-position P&L percent from the feed (e.g. 30.9 = +30.9%). */
  percentPnl?: number | null;
  /** true when `avgPrice` was reconstructed locally (buy history), not supplied by the feed. */
  costEstimated?: boolean;
}

export interface PositionPnl {
  known: boolean;
  /** Position-level unrealized P&L in USDC. */
  pnl: number;
  /** Position-level P&L percent. */
  pct: number;
  estimated: boolean;
}

/**
 * Position-level unrealized P&L. Prefers the feed's `cashPnl`/`percentPnl`; otherwise derives
 * it from `avgPrice` vs `curPrice`. `known: false` when there's no cost basis to compare against.
 */
export function positionPnl(position: SellablePosition): PositionPnl {
  if (typeof position.cashPnl === 'number' && typeof position.percentPnl === 'number') {
    return { known: true, pnl: position.cashPnl, pct: position.percentPnl, estimated: false };
  }
  if (typeof position.avgPrice === 'number' && position.avgPrice > 0) {
    const pnl = (position.curPrice - position.avgPrice) * position.size;
    const pct = ((position.curPrice - position.avgPrice) / position.avgPrice) * 100;
    return { known: true, pnl, pct, estimated: position.costEstimated === true };
  }
  return { known: false, pnl: 0, pct: 0, estimated: false };
}

/** Compact P&L badge, e.g. `📈 浮盈 +$13.00 (+30.9%)` / `📉 浮亏 -$4.10 (-9.5%)` / `持平`. */
export function formatPnl(pnl: PositionPnl): string {
  if (!pnl.known) {
    return '盈亏:成本未知';
  }
  const suffix = pnl.estimated ? ' (估算)' : '';
  if (Math.abs(pnl.pnl) < 0.005) {
    return `持平${suffix}`;
  }
  const up = pnl.pnl > 0;
  const sign = up ? '+' : '-';
  return `${up ? '📈 浮盈' : '📉 浮亏'} ${sign}$${Math.abs(pnl.pnl).toFixed(2)} (${sign}${Math.abs(pnl.pct).toFixed(1)}%)${suffix}`;
}

/** Realized-P&L badge for selling `shares` at the current price (e.g. `📈 赚 +$2.50`); null when
 *  cost basis is unknown. Callers add their own lead-in (确认页 / 已提交页 wording differs). */
export function formatRealizedPnl(position: SellablePosition, shares: number): string | null {
  if (!(typeof position.avgPrice === 'number' && position.avgPrice > 0)) {
    return null;
  }
  const pnl = (position.curPrice - position.avgPrice) * shares;
  const suffix = position.costEstimated ? ' (估算)' : '';
  if (Math.abs(pnl) < 0.005) {
    return `基本持平${suffix}`;
  }
  const up = pnl > 0;
  return `${up ? '📈 赚' : '📉 亏'} ${up ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}${suffix}`;
}

export function buildStartReply(): BotReply {
  return {
    text: [
      '欢迎来到 NewBot。',
      '这里先帮你看市场、记住对话，后面再接下单和账户绑定。',
      '如果你现在不知道从哪开始，就先看市场，再决定要不要继续。',
    ].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildAccountReply(account: TradingAccountRow | null): BotReply {
  if (account) {
    const signerTail = account.signer_address ? shortenAddress(account.signer_address) : '待补充';
    return {
      text: [
        '你的交易账户已经绑定好了。',
        account.account_label ? `账户名：${account.account_label}` : '账户名：未设置',
        `接入方式：${formatAuthMode(account.auth_mode)}`,
        `Signer：${signerTail}`,
        account.funder_address ? `Funder：${shortenAddress(account.funder_address)}` : 'Funder：待补充',
        '现在你可以继续看市场、记订单，下一步再把真实下单接口接上。',
      ].join('\n'),
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  return {
    text: '你还没绑定交易账户。后面我会带你完成 managed signer / 钱包接入，先把基础流程跑顺。',
    replyMarkup: {
      inline_keyboard: [
        [{ text: '开始绑定', callback_data: 'start_link_account' }],
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildLinkAccountReply(linkCode: string, expiresAt: string): BotReply {
  return {
    text: [
      '绑定入口已经给你准备好了。',
      `链接口令：${linkCode}`,
      `有效期到：${expiresAt.slice(0, 16).replace('T', ' ')}`,
      '下一步直接打开 portal 填一下账户信息，就能把绑定状态真正写进系统。',
    ].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildTradeEntryReply(hasLinkedAccount: boolean): BotReply {
  if (hasLinkedAccount) {
    return {
      text: '下单前确认流已经往前推进了一步。你现在可以直接发 /buy btc yes 50 这种格式先走模拟下单。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  return {
    text: '下单前要先绑定交易账户。我已经把绑定入口给你放好了，先完成这一步再继续。',
    replyMarkup: {
      inline_keyboard: [
        [{ text: '开始绑定', callback_data: 'start_link_account' }],
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildBuyConfirmReply(amountText: string): BotReply {
  return {
    text: [
      '下单确认占位已经升级了。',
      `如果你只是先试金额，本次计划金额：${amountText} USDC。`,
      '想直接记一笔模拟单，可以发：/buy btc yes 50',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '看市场', callback_data: 'market_overview' }],
        [{ text: '我的账户', callback_data: 'account_status' }],
      ],
    },
  };
}

export function buildSubmittedBuyReply(
  market: MarketItem,
  outcome: string,
  amountUsdc: number,
  orderId: string,
  mode: 'live' | 'simulated',
  status: string,
  note?: string,
): BotReply {
  const title = mode === 'live' ? '真实下单请求已经发出。' : '模拟下单已经记录。';
  const tail = note ?? (mode === 'live'
    ? '你现在可以发 /orders 看状态，后面我再把真实成交和回执细节接进来。'
    : '还没接入真实下单 API，所以这笔先按模拟单记录。你现在可以发 /orders 看订单，或者发 /positions 看当前记录里的模拟仓位。');
  return {
    text: [
      title,
      `${market.question}`,
      `方向：${outcome}`,
      `金额：${amountUsdc} USDC`,
      `订单号：${orderId}`,
      `状态：${status}`,
      tail,
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '看市场', callback_data: 'market_overview' }],
        [{ text: '我的账户', callback_data: 'account_status' }],
      ],
    },
  };
}

export function buildBuyErrorReply(
  market: MarketItem,
  outcome: string,
  amountUsdc: number,
  error: { code: string; userMessage: string; retryable: boolean },
): BotReply {
  const retryLine = error.retryable
    ? '这个问题通常是暂时的，过一会儿可以再试一次。'
    : '先别急着重复下单，等问题解决了再发一次。';
  return {
    text: [
      '真实下单没有成功。',
      market.question,
      `方向：${outcome}`,
      `金额：${amountUsdc} USDC`,
      `原因：${error.userMessage}`,
      retryLine,
      '你可以发 /orders 看记录，或发 /health 看系统状态。',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '看市场', callback_data: 'market_overview' }],
        [{ text: '我的账户', callback_data: 'account_status' }],
      ],
    },
  };
}

export function buildOrdersReply(events: TradeEventRow[]): BotReply {
  if (events.length === 0) {
    return {
      text: '你这边还没有订单记录。先绑定账户，然后可以直接发 /buy btc yes 50 先记一笔模拟单。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const lines = events.slice(0, 5).map((event, index) => (
    `${index + 1}. ${event.market_slug}\n   ${event.outcome} · ${event.amount_usdc} USDC · ${event.status}${event.order_id ? ` · ${event.order_id}` : ''}`
  ));

  return {
    text: [`最近 ${Math.min(events.length, 5)} 条订单记录：`, ...lines].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildOpenOrdersReply(
  orders: RemoteOpenOrder[],
  page = 1,
  pageSize = 2,
  dataSource: RemoteDataSource = 'live',
  warning: string | null = null,
): BotReply {
  if (orders.length === 0) {
    return {
      text: '你这边暂时没有未成交订单。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const { items, totalPages, currentPage } = paginateItems(orders, page, pageSize);
  const lines = items.map((order, index) => (
    `${index + 1}. ${order.marketSlug}\n   ${order.outcome} · ${order.amountUsdc} USDC · ${order.status} · ${order.orderId}`
  ));
  return {
    text: [
      formatDataFreshnessLine(dataSource, warning),
      `当前 ${orders.length} 条未成交订单：`,
      `第 ${currentPage} 页 / 共 ${totalPages} 页`,
      ...lines,
    ].filter(Boolean).join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...buildOpenOrderActionRows(items, currentPage),
        ...buildPaginationRows('openorders_page', currentPage, totalPages),
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildPositionsReply(events: TradeEventRow[]): BotReply {
  if (events.length === 0) {
    return {
      text: '你这边还没有可展示的仓位。等你先记下几笔订单后，我就能把它们整理成持仓视图。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const lines = events.slice(0, 5).map((event, index) => (
    `${index + 1}. ${event.market_slug}\n   ${event.outcome} 方向 · ${event.amount_usdc} USDC`
  ));

  return {
    text: ['当前记录里的模拟仓位：', ...lines].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildRemotePositionsReply(
  positions: RemotePosition[],
  page = 1,
  pageSize = 2,
  dataSource: RemoteDataSource = 'live',
  warning: string | null = null,
): BotReply {
  if (positions.length === 0) {
    return {
      text: '你这边暂时没有持仓。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const { items, totalPages, currentPage } = paginateItems(positions, page, pageSize);
  const totalExposure = positions.reduce((sum, position) => sum + position.sizeUsdc, 0);
  const totalRealizedPnl = positions.reduce((sum, position) => sum + resolveRealizedPnl(position), 0);
  const totalUnrealizedPnl = positions.reduce((sum, position) => sum + resolveUnrealizedPnl(position), 0);
  const lines = items.map((position, index) => {
    const unrealizedPnl = resolveUnrealizedPnl(position);
    const realizedPnl = resolveRealizedPnl(position);
    const pnlParts: string[] = [];
    if (typeof position.avgPrice === 'number') {
      pnlParts.push(`均价 ${position.avgPrice}`);
    }
    if (unrealizedPnl !== 0 || typeof position.currentPrice === 'number') {
      pnlParts.push(`未实现 ${formatSignedUsd(unrealizedPnl)}`);
    }
    if (realizedPnl !== 0) {
      pnlParts.push(`已实现 ${formatSignedUsd(realizedPnl)}`);
    }
    const tail = pnlParts.length > 0 ? ` · ${pnlParts.join(' · ')}` : '';
    return `${index + 1}. ${position.marketSlug}\n   ${position.outcome} · ${position.sizeUsdc} USDC${tail}`;
  });

  return {
    text: [
      formatDataFreshnessLine(dataSource, warning),
      `当前 ${positions.length} 条持仓：`,
      `第 ${currentPage} 页 / 共 ${totalPages} 页`,
      `总敞口：${formatUsdc(totalExposure)}`,
      `已实现：${formatSignedUsd(totalRealizedPnl)}`,
      `未实现：${formatSignedUsd(totalUnrealizedPnl)}`,
      `分页游标：p${currentPage}`,
      ...(currentPage < totalPages ? [`下一页 token：p${currentPage + 1}`] : []),
      ...lines,
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...buildPaginationRows('positions_page', currentPage, totalPages),
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildFillsReply(
  fills: RemoteFill[],
  page = 1,
  pageSize = 2,
  dataSource: RemoteDataSource = 'live',
  warning: string | null = null,
): BotReply {
  if (fills.length === 0) {
    return {
      text: '最近还没有成交记录。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const { items, totalPages, currentPage } = paginateItems(fills, page, pageSize);
  const lines = items.map((fill, index) => (
    `${index + 1}. ${fill.marketSlug}\n   ${fill.side} · ${fill.outcome} · ${fill.amountUsdc} USDC${typeof fill.price === 'number' ? ` · 成交价 ${fill.price}` : ''}`
  ));

  return {
    text: [formatDataFreshnessLine(dataSource, warning), `最近 ${fills.length} 条成交记录：`, `第 ${currentPage} 页 / 共 ${totalPages} 页`, ...lines]
      .filter(Boolean)
      .join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...buildPaginationRows('fills_page', currentPage, totalPages),
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

/** How many markets to show per page in the /markets and /search lists. */
export const MARKET_PAGE_SIZE = 5;

export function buildMarketOverviewReply(markets: MarketItem[], page = 1): BotReply {
  if (markets.length === 0) {
    return {
      text: '现在没拉到市场数据，你过一会儿再试，我会优先把看市场入口补稳。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const { items, totalPages, currentPage } = paginateItems(markets, page, MARKET_PAGE_SIZE);
  const startIndex = (currentPage - 1) * MARKET_PAGE_SIZE;
  const lines = items.map((market, index) => {
    const volumeText = formatUsd(market.volume);
    const endText = market.endDate ? `，截止 ${market.endDate.slice(0, 10)}` : '';
    return `${startIndex + index + 1}. ${market.question}\n   成交额 ${volumeText}${endText}`;
  });

  const buyRows = buildMarketListBuyRows(items, startIndex);
  return {
    text: [
      `活跃市场（第 ${currentPage}/${totalPages} 页，共 ${markets.length} 个，点按钮直接买）：`,
      ...lines,
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...buyRows,
        ...buildPaginationRows('market_page', currentPage, totalPages),
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildMarketSearchReply(query: string, markets: MarketItem[], page = 1): BotReply {
  if (markets.length === 0) {
    return {
      text: `我暂时没找到和“${query}”相关的活跃市场。你可以换个关键词，比如 btc、eth、election。`,
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const { items, totalPages, currentPage } = paginateItems(markets, page, MARKET_PAGE_SIZE);
  const startIndex = (currentPage - 1) * MARKET_PAGE_SIZE;
  const lines = items.map((market, index) => {
    const volumeText = formatUsd(market.volume);
    return `${startIndex + index + 1}. ${market.question}\n   成交额 ${volumeText}`;
  });

  const buyRows = buildMarketListBuyRows(items, startIndex);
  return {
    text: [
      `“${query}”相关市场（第 ${currentPage}/${totalPages} 页，共 ${markets.length} 个，点按钮直接买）：`,
      ...lines,
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...buyRows,
        ...buildPaginationRows(`market_search:${encodeSearchQuery(query)}`, currentPage, totalPages),
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildMarketDetailReply(query: string, market: MarketItem | null): BotReply {
  if (!market) {
    return {
      text: `我还没找到和“${query}”最匹配的市场。你可以换个更具体的关键词试试。`,
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const outcomeLine = market.outcomes?.length
    ? `方向：${market.outcomes.map((outcome) => `${outcome.name}${typeof outcome.price === 'number' ? ` ${Math.round(outcome.price * 100)}%` : ''}`).join(' / ')}`
    : '方向数据待补充';

  const buyRow = buildBuyOutcomeButtons(market);

  return {
    text: [
      '你先看这个市场：',
      market.question,
      `成交额 ${formatUsd(market.volume)}`,
      market.endDate ? `截止 ${market.endDate.slice(0, 10)}` : '截止时间待确认',
      outcomeLine,
      buyRow.length ? '点下面的按钮直接买，不用打字。' : '继续可发 /buy <市场> yes 1 这种格式。',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...(buyRow.length ? [buyRow] : []),
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

/** Per-outcome "买 Yes/No" buttons for a market (callback re-resolves by the short market id). */
function buildBuyOutcomeButtons(market: MarketItem, labelPrefix = ''): Array<{ text: string; callback_data: string }> {
  // Use the short numeric gamma id as the callback key so callback_data stays well under
  // Telegram's 64-byte limit regardless of how long the market slug is.
  const key = market.id ?? '';
  if (!key || !market.outcomes?.length) {
    return [];
  }
  return market.outcomes
    .map((outcome, idx) => ({ outcome, idx }))
    .filter(({ outcome }) => typeof outcome.tokenId === 'string' && outcome.tokenId.length > 0)
    .slice(0, 3)
    .map(({ outcome, idx }) => {
      const priceLabel = typeof outcome.price === 'number' ? ` ${Math.round(outcome.price * 100)}%` : '';
      return { text: `${labelPrefix}买 ${outcome.name}${priceLabel}`, callback_data: `bp:${key}:${idx}` };
    });
}

/** Rows of per-market buy buttons for a market list (numbered to match the text). */
function buildMarketListBuyRows(
  markets: MarketItem[],
  startIndex = 0,
): Array<Array<{ text: string; callback_data: string }>> {
  return markets
    .map((market, i) => buildBuyOutcomeButtons(market, `${startIndex + i + 1}. `))
    .filter((row) => row.length > 0);
}

/**
 * Pack a search query into a byte-safe fragment for a pagination callback_data.
 * Telegram caps callback_data at 64 bytes; the `market_search:` prefix + `:<page>`
 * suffix take ~17, so keep the query under ~40 bytes (CJK-aware).
 */
function encodeSearchQuery(query: string): string {
  const cleaned = query.replace(/:/g, ' ').trim();
  let bytes = 0;
  let out = '';
  for (const ch of cleaned) {
    const chBytes = new TextEncoder().encode(ch).length;
    if (bytes + chBytes > 40) {
      break;
    }
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/** Step 2: after picking an outcome, show amount buttons. */
export function buildBuyAmountReply(market: MarketItem, outcomeIdx: number): BotReply {
  const key = market.id ?? '';
  const outcome = market.outcomes?.[outcomeIdx];
  const name = outcome?.name ?? '该方向';
  return {
    text: [`市场：${market.question}`, `方向：买 ${name}`, '选个金额（USDC）：'].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [1, 2, 5].map((amt) => ({ text: `$${amt}`, callback_data: `ba:${key}:${outcomeIdx}:${amt}` })),
        [{ text: '‹ 返回', callback_data: 'market_overview' }],
      ],
    },
  };
}

/** Step 3: confirm button before placing the real order. */
export function buildBuyConfirmButtonReply(market: MarketItem, outcomeIdx: number, amountUsdc: number): BotReply {
  const key = market.id ?? '';
  const outcome = market.outcomes?.[outcomeIdx];
  const name = outcome?.name ?? '该方向';
  return {
    text: [`确认下单：`, market.question, `买 ${name} · $${amountUsdc}`, '点“确认”即真实下单。'].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: `✅ 确认 买${name} $${amountUsdc}`, callback_data: `bg:${key}:${outcomeIdx}:${amountUsdc}` },
          { text: '取消', callback_data: 'market_overview' },
        ],
      ],
    },
  };
}

// --- Sell (close position) flow: list positions -> pick all/half -> confirm -> place ---

/** Short, unique-enough key from a 77-digit CTF tokenId for callback_data (64-byte limit). */
export function tokenKey(tokenId: string): string {
  return tokenId.slice(0, 18);
}

function formatShares(size: number): string {
  return Number.isInteger(size) ? String(size) : size.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** /positions when live: real holdings with per-position 卖出 buttons. */
export function buildSellPositionsReply(positions: SellablePosition[]): BotReply {
  if (positions.length === 0) {
    return {
      text: '你当前没有可卖的持仓。先发 /markets 点按钮买入,成交后就能在这里卖出。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const shown = positions.slice(0, 8);
  const lines = shown.map((position, index) => {
    const value = position.size * position.curPrice;
    const pnl = positionPnl(position);
    const costLine = pnl.known
      ? `\n   成本 ${(position.avgPrice ?? 0).toFixed(3)} · ${formatPnl(pnl)}`
      : '';
    return `${index + 1}. ${position.title}\n   ${position.outcome} · ${formatShares(position.size)} 份 · 现价 ${position.curPrice.toFixed(3)} · 约 $${value.toFixed(2)}${costLine}`;
  });

  const buttonRows = shown.map((position, index) => {
    const key = tokenKey(position.tokenId);
    return [
      { text: `${index + 1}. 卖全部`, callback_data: `sp:${key}:a` },
      { text: '卖一半', callback_data: `sp:${key}:h` },
    ];
  });

  return {
    text: ['你的持仓(点按钮卖出):', ...lines].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        ...buttonRows,
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

/** Step 2: confirm before placing the real sell order. */
export function buildSellConfirmReply(position: SellablePosition, fraction: 'a' | 'h', shares: number): BotReply {
  const key = tokenKey(position.tokenId);
  const proceeds = shares * position.curPrice;
  const label = fraction === 'a' ? '全部' : '一半';
  const realized = formatRealizedPnl(position, shares);
  const costLine =
    typeof position.avgPrice === 'number' && position.avgPrice > 0 && realized
      ? `成本价 ${position.avgPrice.toFixed(3)} · 这笔预计 ${realized}`
      : null;
  return {
    text: [
      '确认卖出:',
      position.title,
      `${position.outcome} · 卖${label} ${formatShares(shares)} 份`,
      `预计到账约 $${proceeds.toFixed(2)}(按现价 ${position.curPrice.toFixed(3)}）`,
      ...(costLine ? [costLine] : []),
      '点"确认"即真实卖出。',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: `✅ 确认卖${label}`, callback_data: `sx:${key}:${fraction}` },
          { text: '取消', callback_data: 'sell_positions' },
        ],
      ],
    },
  };
}

/** Result reply after a sell order is submitted. */
export function buildSellSubmittedReply(
  position: SellablePosition,
  shares: number,
  orderId: string,
  status: string,
  mode: 'live' | 'simulated',
): BotReply {
  const title = mode === 'live' ? '卖出请求已发出。' : '模拟卖出已记录。';
  const realized = formatRealizedPnl(position, shares);
  const pnlLine =
    typeof position.avgPrice === 'number' && position.avgPrice > 0 && realized
      ? `预计盈亏:${realized}（成本 ${position.avgPrice.toFixed(3)} → 现价 ${position.curPrice.toFixed(3)}）`
      : null;
  return {
    text: [
      title,
      position.title,
      `方向:卖 ${position.outcome}`,
      `数量:${formatShares(shares)} 份`,
      ...(pnlLine ? [pnlLine] : []),
      `订单号:${orderId}`,
      `状态:${status}`,
      '可发 /positions 看剩余持仓,或 /balance 看余额。',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '看持仓', callback_data: 'sell_positions' }],
        [{ text: '看市场', callback_data: 'market_overview' }],
      ],
    },
  };
}

export function buildGettingStartedReply(): BotReply {
  return {
    text: [
      '最简单的开始方式：',
      '1. 先点“看市场”，熟悉现在有哪些热门盘。',
      '2. 再点“我的账户”，确认自己是不是已经绑定。',
      '3. 需要的话直接发 /link，先把账户接入入口拿到。',
      '4. 绑定后可以先发 /buy btc yes 50，走一遍模拟订单链路。',
    ].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildDefaultReply(): BotReply {
  return {
    text: '我先记下了。现在 Phase 41 已经支持 /start、/account、/market、/find、/detail、/link、/buy、/orders、/openorders、/positions、/fills、/cancel、/health、/runbook、/metrics；也有会自动刷新、带状态徽章、最新 smoke 时间、Freshness、趋势圆点、环境过滤、快捷切换入口和 check detail 的 smoke dashboard。',
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildOperatorOnlyReply(): BotReply {
  return {
    text: '这个系统状态入口只给配置过的操作者使用。你可以继续用 /market、/account 或 /orders 查看自己的交易信息。',
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildHealthReply(readiness: OrderGatewayReadiness): BotReply {
  const warningLines = readiness.warnings.length > 0
    ? readiness.warnings.map((warning) => `- ${warning}`)
    : ['暂时没有配置告警'];

  return {
    text: [
      'NewBot 当前状态：',
      `交易模式：${readiness.tradingMode === 'live' ? '真实下单（live）' : '模拟下单（simulated）'}`,
      `Live order API：${readiness.liveOrderApi ? '已配置' : '未完整配置'}`,
      `Canonical signing：${readiness.signing ? '已启用' : '未启用'}`,
      `Builder attribution：${readiness.builderAttribution}`,
      `Live trading allowlist：${readiness.liveTradingAllowlist ? '已启用' : '未启用'}`,
      '配置提示：',
      ...warningLines,
    ].join('\n'),
    replyMarkup: buildOperatorMenuMarkup(),
  };
}

export function buildSmokeMetricsReply(metrics: SmokeReportMetrics): BotReply {
  const environmentLines = metrics.environments.length > 0
    ? metrics.environments.map((environment) => {
      const latestStatus = environment.latestStatus === 'ok' ? '通过' : '失败';
      return `- ${environment.environment}：${environment.total} 次 / 通过 ${environment.passed} / 失败 ${environment.failed} / 最新${latestStatus}\n  ${environment.latestTarget}（${environment.latestCreatedAt}）`;
    })
    : ['还没有带环境标签的 smoke 记录'];

  return {
    text: [
      'Phase 32 smoke metrics：',
      `最近 smoke：${metrics.total} 次`,
      `通过：${metrics.passed}`,
      `失败：${metrics.failed}`,
      `通过率：${formatPercentage(metrics.passRate)}`,
      '各环境：',
      ...environmentLines,
    ].join('\n'),
    replyMarkup: buildOperatorMenuMarkup(),
  };
}

export function buildRunbookReply(
  readiness: OrderGatewayReadiness,
  latestSmokeReport?: SmokeReportRun | null,
  smokeReportsByEnvironment: SmokeReportRun[] = [],
  selectedEnvironment?: string,
): BotReply {
  const blockers = readiness.warnings.length > 0
    ? readiness.warnings.map((warning) => `- ${warning}`)
    : ['暂时没有阻断项'];
  const smokeLines = buildSmokeReportLines(latestSmokeReport);
  const environmentSmokeLines = buildEnvironmentSmokeReportLines(smokeReportsByEnvironment);
  const title = selectedEnvironment ? `Phase 30 灰度 runbook（${selectedEnvironment}）` : 'Phase 30 灰度 runbook：';

  return {
    text: [
      title,
      `交易模式：${readiness.tradingMode === 'live' ? '真实下单（live）' : '模拟下单（simulated）'}`,
      `Live order API：${readiness.liveOrderApi ? '已配置' : '未完整配置'}`,
      `Canonical signing：${readiness.signing ? '已启用' : '未启用'}`,
      `Builder attribution：${readiness.builderAttribution}`,
      `Live trading allowlist：${readiness.liveTradingAllowlist ? '已启用' : '未启用'}`,
      ...smokeLines,
      ...environmentSmokeLines,
      '上线前：',
      '- npm run smoke -- <worker-url>',
      '- npm run smoke -- --require-ready <worker-url>',
      '- 可选：加 --report-url /ops/smoke-report 和 --report-env production 回传 smoke 结果',
      '- /health 确认没有阻断项',
      '放量顺序：',
      '- 1% / allowlist：只放内部操作者和少量测试用户',
      '- 10%：观察 webhook、订单状态同步和撤单回路',
      '- 100%：确认 30 分钟没有新增告警再全量',
      '回滚条件：',
      '- smoke 失败、webhook 401 防护异常、live order API/signing 缺失，先停放量',
      '当前阻断项：',
      ...blockers,
    ].join('\n'),
    replyMarkup: buildOperatorMenuMarkup(),
  };
}

function buildSmokeReportLines(report?: SmokeReportRun | null): string[] {
  if (!report) {
    return ['最近 smoke：还没有回传记录'];
  }

  if (!report.detail) {
    return [`最近 smoke：${report.status === 'ok' ? '通过' : '失败'}（${report.createdAt}，报告内容无法解析）`];
  }

  const checkLines = report.detail.checks.slice(0, 3).map((check) => {
    const state = check.ok ? '通过' : '失败';
    return `- ${check.name} ${state}`;
  });
  const status = report.detail.ok ? '通过' : '失败';
  const environmentLine = report.detail.environment ? [`环境：${report.detail.environment}`] : [];
  return [
    `最近 smoke：${status}`,
    `目标：${report.detail.target}`,
    ...environmentLine,
    `时间：${report.createdAt}`,
    ...checkLines,
  ];
}

function buildEnvironmentSmokeReportLines(reports: SmokeReportRun[]): string[] {
  const lines = reports
    .filter((report) => report.detail?.environment)
    .map((report) => {
      const detail = report.detail;
      if (!detail?.environment) {
        return null;
      }
      const status = detail.ok ? '通过' : '失败';
      return `- ${detail.environment} ${status}：${detail.target}（${report.createdAt}）`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return [];
  }

  return ['各环境 smoke：', ...lines];
}

export function buildMainMenuMarkup(): TelegramMenuMarkup {
  return {
    inline_keyboard: [
      [{ text: '看市场', callback_data: 'market_overview' }],
      [{ text: '我的账户', callback_data: 'account_status' }],
      [{ text: '系统状态', callback_data: 'ops_health' }],
      [{ text: '怎么开始', callback_data: 'getting_started' }],
    ],
  };
}

function buildOperatorMenuMarkup(): TelegramMenuMarkup {
  return {
    inline_keyboard: [
      [{ text: '系统状态', callback_data: 'ops_health' }],
      [{ text: '灰度 Runbook', callback_data: 'ops_runbook' }],
      [{ text: 'Smoke Metrics', callback_data: 'ops_smoke_metrics' }],
      [
        { text: 'Production', callback_data: 'ops_runbook_env:production' },
        { text: 'Staging', callback_data: 'ops_runbook_env:staging' },
        { text: 'Canary', callback_data: 'ops_runbook_env:canary' },
      ],
      [{ text: '看市场', callback_data: 'market_overview' }],
      [{ text: '我的账户', callback_data: 'account_status' }],
    ],
  };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '$0';
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function shortenAddress(value: string): string {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatAuthMode(value: string): string {
  return value.replaceAll('_', ' ');
}

function paginateItems<T>(items: T[], page: number, pageSize: number): { items: T[]; currentPage: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    currentPage,
    totalPages,
  };
}

function buildPaginationRows(prefix: string, currentPage: number, totalPages: number): TelegramMenuMarkup['inline_keyboard'] {
  if (totalPages <= 1) {
    return [];
  }

  const row: Array<{ text: string; callback_data: string }> = [];
  if (currentPage > 1) {
    row.push({ text: '上一页', callback_data: `${prefix}:${currentPage - 1}` });
  }
  if (currentPage < totalPages) {
    row.push({ text: '下一页', callback_data: `${prefix}:${currentPage + 1}` });
  }
  return row.length > 0 ? [row] : [];
}

function buildOpenOrderActionRows(orders: RemoteOpenOrder[], page: number): TelegramMenuMarkup['inline_keyboard'] {
  return orders.map((order) => ([{
    text: `撤单 ${shortOrderId(order.orderId)}`,
    callback_data: `cancel_open_order:${order.orderId}:${page}`,
  }]));
}

function formatDataFreshnessLine(dataSource: RemoteDataSource, warning: string | null): string | null {
  if (warning) {
    return warning;
  }
  if (dataSource === 'live') {
    return '数据来源：实时';
  }
  if (dataSource === 'cache') {
    return '数据来源：缓存';
  }
  return null;
}

function shortOrderId(value: string): string {
  if (value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatUsdc(value: number): string {
  if (Number.isInteger(value)) {
    return `${value} USDC`;
  }
  return `${value.toFixed(2)} USDC`;
}

function resolveRealizedPnl(position: RemotePosition): number {
  return typeof position.realizedPnl === 'number' ? position.realizedPnl : 0;
}

function resolveUnrealizedPnl(position: RemotePosition): number {
  if (typeof position.unrealizedPnl === 'number') {
    return position.unrealizedPnl;
  }
  if (typeof position.avgPrice === 'number' && typeof position.currentPrice === 'number') {
    return (position.currentPrice - position.avgPrice) * position.sizeUsdc;
  }
  return 0;
}

function formatSignedUsd(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}
