/**
 * Simple Phase 2 reply builders.
 */

export interface TelegramMenuMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface BotReply {
  text: string;
  replyMarkup?: TelegramMenuMarkup;
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

export function buildDefaultReply(): BotReply {
  return {
    text: '我先记下了。现在 Phase 2 先支持 /start 和 /account，下一步我会继续把看市场和账户流程接上。',
    replyMarkup: buildMainMenuMarkup(),
  };
}

function buildMainMenuMarkup(): TelegramMenuMarkup {
  return {
    inline_keyboard: [
      [{ text: '我的账户', callback_data: 'account_status' }],
      [{ text: '怎么开始', callback_data: 'getting_started' }],
    ],
  };
}
