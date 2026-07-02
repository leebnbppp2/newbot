-- Phase 44 (Privy 托管签名 C):为 Privy server wallet + Gnosis Safe 开通追加列。
-- 追加式迁移,不改 0001。语义复用:EOA -> signer_address;Safe -> funder_address(同时也是 deposit_address_evm)。
-- 注意:ALTER TABLE ADD COLUMN 不幂等,勿对同一库重复 apply。

ALTER TABLE user_trading_accounts ADD COLUMN privy_user_id TEXT;
ALTER TABLE user_trading_accounts ADD COLUMN privy_wallet_id TEXT;
ALTER TABLE user_trading_accounts ADD COLUMN safe_deployed_at TEXT;
ALTER TABLE user_trading_accounts ADD COLUMN approvals_set_at TEXT;

ALTER TABLE trade_events ADD COLUMN client_order_id TEXT;
CREATE INDEX idx_trade_events_client_order_id ON trade_events(client_order_id);
