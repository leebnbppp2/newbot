/**
 * Simple Phase 3 reply builders.
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
    replyMarkup: buildMainMenuMarkup(),
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
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildGettingStartedReply(): BotReply {
  return {
    text: [
      '最简单的开始方式：',
      '1. 先点“看市场”，熟悉现在有哪些热门盘。',
      '2. 再点“我的账户”，确认自己是不是已经绑定。',
      '3. 等下一阶段接上下单前确认流，再决定要不要真实交易。',
    ].join('\n'),
    replyMarkup: buildMainMenuMarkup(),
  };
}

export function buildDefaultReply(): BotReply {
  return {
    text: '我先记下了。现在 Phase 3 已经支持 /start、/account、/market，也可以直接点菜单继续走。',
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
