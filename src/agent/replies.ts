/**
 * Simple Phase 5 reply builders.
 */

export interface TelegramMenuMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface BotReply {
  text: string;
  replyMarkup?: TelegramMenuMarkup;
}

export interface MarketItem {
  question: string;
  volume: number;
  endDate?: string;
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

export function buildAccountReply(hasLinkedAccount: boolean): BotReply {
  if (hasLinkedAccount) {
    return {
      text: '你的交易账户已经绑定好了。下一步我会继续带你接入下单和持仓视图。',
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
      '下一步我会把它接到真实钱包 / managed signer 流程，现在先把入口和状态打通。',
    ].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildTradeEntryReply(hasLinkedAccount: boolean): BotReply {
  if (hasLinkedAccount) {
    return {
      text: '下单前确认流的骨架已经准备好了。下一步我会接真实市场选择、金额确认和最终下单。',
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
      '下单确认占位已经准备好了。',
      `本次计划金额：${amountText} USDC`,
      '下一步我会把它接成：选市场 → 选方向 → 最终确认 → 提交订单。',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '看市场', callback_data: 'market_overview' }],
        [{ text: '我的账户', callback_data: 'account_status' }],
      ],
    },
  };
}

export function buildMarketOverviewReply(markets: MarketItem[]): BotReply {
  if (markets.length === 0) {
    return {
      text: '现在没拉到市场数据，你过一会儿再试，我会优先把看市场入口补稳。',
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const lines = markets.slice(0, 3).map((market, index) => {
    const volumeText = formatUsd(market.volume);
    const endText = market.endDate ? `，截止 ${market.endDate.slice(0, 10)}` : '';
    return `${index + 1}. ${market.question}\n   成交额 ${volumeText}${endText}`;
  });

  return {
    text: ['先看 3 个活跃市场：', ...lines, '', '如果你想继续，我下一步就可以带你做更细的市场查询。'].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '准备下单', callback_data: 'trade_entry' }],
        ...buildMainMenuMarkup().inline_keyboard,
      ],
    },
  };
}

export function buildMarketSearchReply(query: string, markets: MarketItem[]): BotReply {
  if (markets.length === 0) {
    return {
      text: `我暂时没找到和“${query}”相关的活跃市场。你可以换个关键词，比如 btc、eth、election。`,
      replyMarkup: buildMainMenuMarkup(),
    };
  }

  const lines = markets.slice(0, 3).map((market, index) => {
    const volumeText = formatUsd(market.volume);
    return `${index + 1}. ${market.question}\n   成交额 ${volumeText}`;
  });

  return {
    text: [`给你找了 ${Math.min(markets.length, 3)} 个和“${query}”相关的市场：`, ...lines, '', '如果你想看某个方向，我下一步可以继续细化筛选。'].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '准备下单', callback_data: 'trade_entry' }],
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

  return {
    text: [
      '你先看这个市场：',
      market.question,
      `成交额 ${formatUsd(market.volume)}`,
      market.endDate ? `截止 ${market.endDate.slice(0, 10)}` : '截止时间待确认',
      '如果你想继续，直接发 /buy 50，我就把它带到下单前确认流。',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [{ text: '准备下单', callback_data: 'trade_entry' }],
        ...buildMainMenuMarkup().inline_keyboard,
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
      '4. 等下一阶段接上下单前确认流，再决定要不要真实交易。',
    ].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildDefaultReply(): BotReply {
  return {
    text: '我先记下了。现在 Phase 5 已经支持 /start、/account、/market、/find、/detail、/link、/buy，也可以直接点菜单继续走。',
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildMainMenuMarkup(): TelegramMenuMarkup {
  return {
    inline_keyboard: [
      [{ text: '看市场', callback_data: 'market_overview' }],
      [{ text: '我的账户', callback_data: 'account_status' }],
      [{ text: '怎么开始', callback_data: 'getting_started' }],
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
