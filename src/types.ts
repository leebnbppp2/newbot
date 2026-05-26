/**
 * Shared Worker environment and Telegram payload types used in Phase 1.
 */

export interface Env {
  DB: D1Database;
  TRADE_COORDINATOR: DurableObjectNamespace;
  APP_ENV?: string;
  NEWBOT_VERSION?: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  BOT_TOKEN_CRYPTO_ZH: string;
  POLYMARKET_ORDER_API_BASE?: string;
  POLYMARKET_ORDER_API_KEY?: string;
  POLYMARKET_ORDER_SIGNING_SECRET?: string;
  POLYMARKET_BUILDER_TAG?: string;
  POLYMARKET_BUILDER_API_KEY?: string;
  NEWBOT_OPERATOR_TELEGRAM_IDS?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
