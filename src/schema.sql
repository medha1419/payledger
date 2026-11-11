-- PayLedger schema
-- Money is stored as BIGINT paise (1 INR = 100 paise). Never use floats for money:
-- 0.1 + 0.2 !== 0.3 in floating point.

CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  owner_name    TEXT        NOT NULL,
  currency      CHAR(3)     NOT NULL DEFAULT 'INR',
  balance_paise BIGINT      NOT NULL DEFAULT 0,
  is_system     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The database itself refuses a negative balance for user accounts,
  -- even if the application code has a bug.
  CONSTRAINT non_negative_balance CHECK (is_system OR balance_paise >= 0)
);

-- One "transaction" = one business event (a deposit or a transfer).
CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT        NOT NULL CHECK (type IN ('DEPOSIT', 'TRANSFER')),
  from_account_id BIGINT      NOT NULL REFERENCES accounts(id),
  to_account_id   BIGINT      NOT NULL REFERENCES accounts(id),
  amount_paise    BIGINT      NOT NULL CHECK (amount_paise > 0),
  -- UNIQUE makes retries safe: the same key can only ever create one transaction.
  idempotency_key TEXT        NOT NULL UNIQUE,
  status          TEXT        NOT NULL DEFAULT 'COMPLETED',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

-- Double-entry bookkeeping: every transaction writes one debit (negative)
-- and one credit (positive). The entries of a transaction always sum to zero,
-- so money is never created or destroyed by accident.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT      NOT NULL REFERENCES transactions(id),
  account_id     BIGINT      NOT NULL REFERENCES accounts(id),
  amount_paise   BIGINT      NOT NULL CHECK (amount_paise <> 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_account ON ledger_entries(account_id, id DESC);

-- The system account represents money coming in from outside (e.g. a bank top-up).
-- It is allowed to go negative.
INSERT INTO accounts (owner_name, is_system)
SELECT 'EXTERNAL_FUNDING', TRUE
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE is_system);
