-- 1. 用户(per persona,因为同一 telegram_user_id 可能用多个 persona)
CREATE TABLE users (
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language TEXT NOT NULL DEFAULT 'zh',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, bot_id)
);

-- 2. 用户的 Polymarket 交易账号
CREATE TABLE user_trading_accounts (
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_link',
  auth_mode TEXT NOT NULL DEFAULT 'managed_signer',
  signature_type TEXT,
  account_label TEXT,
  signer_address TEXT,
  funder_address TEXT,
  deposit_address_evm TEXT,
  deposit_address_svm TEXT,
  deposit_address_btc TEXT,
  deposit_address_tron TEXT,
  geoblock_blocked INTEGER NOT NULL DEFAULT 0,
  geoblock_country TEXT,
  geoblock_region TEXT,
  geoblock_checked_at TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, bot_id)
);

-- 3. 加密的 Polymarket 凭证
CREATE TABLE user_trading_credentials (
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  encryption_version TEXT NOT NULL DEFAULT 'v1',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, bot_id)
);

-- 4. 钱包接入临时 session
CREATE TABLE user_account_sessions (
  token_hash TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  session_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sessions_user ON user_account_sessions(telegram_user_id, bot_id, session_type, status);

-- 5. 对话历史
CREATE TABLE conversations (
  user_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, turn_id)
);
CREATE INDEX idx_conversations_recent ON conversations(user_id, created_at DESC);

-- 6. 交易事件
CREATE TABLE trade_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  outcome TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT,
  tx_hash TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_trade_events_user ON trade_events(telegram_user_id, bot_id, created_at DESC);

-- 7. Builder 收益归因
CREATE TABLE builder_attributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  trade_event_id INTEGER,
  builder_api_key_hint TEXT,
  order_id TEXT,
  amount_usdc REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (trade_event_id) REFERENCES trade_events(id)
);
CREATE INDEX idx_builder_attr_bot ON builder_attributions(bot_id, created_at DESC);

-- 8. 幂等
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 9. 市场缓存
CREATE TABLE market_cache (
  slug TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 10. 提现请求
CREATE TABLE withdrawal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  destination_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 11. Cron 运行日志
CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
