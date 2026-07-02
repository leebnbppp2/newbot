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
  NEWBOT_TRADING_MODE?: string;
  POLYMARKET_ORDER_API_BASE?: string;
  POLYMARKET_ORDER_API_KEY?: string;
  POLYMARKET_ORDER_SIGNING_SECRET?: string;
  POLYMARKET_BUILDER_TAG?: string;
  POLYMARKET_BUILDER_CODE?: string; // V2 public builder code (commission attribution)
  POLYMARKET_BUILDER_API_KEY?: string;
  ORDER_SERVICE_URL?: string; // local @polymarket/client order sidecar (V2 deposit-wallet orders)
  ORDER_SERVICE_TOKEN?: string;
  NEWBOT_OPERATOR_TELEGRAM_IDS?: string;
  NEWBOT_LIVE_TRADING_TELEGRAM_IDS?: string;
  NEWBOT_SMOKE_REPORT_SECRET?: string;
  // Phase 44 — Privy 托管签名 (C) + Polymarket CLOB 直连
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  PRIVY_AUTHORIZATION_PRIVATE_KEY?: string;
  PRIVY_AUTHORIZATION_PUBLIC_KEY?: string;
  PRIVY_TRADING_POLICY_ID?: string;
  NEWBOT_CREDS_ENCRYPTION_KEY?: string;
  POLYMARKET_CLOB_HOST?: string;
  POLYMARKET_RELAYER_URL?: string;
  POLYGON_RPC_URL?: string;
  POLYMARKET_BUILDER_API_SECRET?: string;
  POLYMARKET_BUILDER_PASSPHRASE?: string;
  NEWBOT_PER_TRADE_MAX_USDC?: string;
  NEWBOT_DAILY_MAX_USDC?: string;
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
