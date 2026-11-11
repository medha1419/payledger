# PayLedger

A payments ledger REST API built with **Node.js, Express and PostgreSQL**. It moves money between accounts the way a payments system has to: **exactly once, never overspending, and never losing a rupee**, even when requests are retried or arrive at the same time.

## What it guarantees

| Problem in real payments | How PayLedger handles it |
|---|---|
| The network drops and the client retries a payment | **Idempotency keys.** Every money-moving request needs an `Idempotency-Key` header. A `UNIQUE` constraint means one key creates at most one transaction; a retry returns the original result. Reusing a key for a different request returns `409`. |
| Two payments from the same account arrive at once (double-spend) | **Row-level locking.** Both accounts are locked with `SELECT ... FOR UPDATE` inside one database transaction, so concurrent transfers wait in line. |
| Two opposite transfers (A→B and B→A) lock each other forever | **Fixed lock order.** Accounts are always locked lowest-id first, so a deadlock cycle cannot form. |
| A crash halfway through a transfer | **Atomic transactions.** Debit, credit and ledger entries happen in one `BEGIN ... COMMIT`; any error rolls everything back. |
| Balances drifting from reality | **Double-entry bookkeeping.** Every transaction writes a debit and a credit that sum to zero, plus a database `CHECK` that rejects negative balances. |
| Floating-point rounding errors | **Integer money.** All amounts are stored as `BIGINT` paise (₹1 = 100 paise). |

## Tested under concurrency

11 integration tests run against a real PostgreSQL database, including:

- **20 simultaneous transfers** of ₹1 against a ₹10 balance: exactly 10 succeed, 10 are rejected, the balance ends at exactly 0.
- **20 simultaneous opposite-direction transfers:** all succeed, no deadlocks, total money conserved.
- **5 simultaneous requests with the same idempotency key:** exactly one transaction is created.
- Ledger invariant check: the entries of every transaction sum to zero.

```bash
npm test
```

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/accounts` | Create an account. Body: `{ "ownerName": "Medha" }` |
| `GET` | `/accounts/:id` | Get an account and its balance |
| `GET` | `/accounts/:id/transactions` | Transaction history (debits and credits) |
| `POST` | `/accounts/:id/deposits` | Add money. Body: `{ "amountPaise": 100000 }`. Header: `Idempotency-Key` |
| `POST` | `/transfers` | Transfer money. Body: `{ "fromAccountId": 2, "toAccountId": 3, "amountPaise": 25050 }`. Header: `Idempotency-Key` |

Errors return a consistent shape, for example `422 { "error": "INSUFFICIENT_FUNDS", "message": "Insufficient funds" }`.

### Example

```bash
curl -X POST localhost:3000/accounts -H "Content-Type: application/json" -d '{"ownerName":"Medha"}'

curl -X POST localhost:3000/accounts/2/deposits \
  -H "Content-Type: application/json" -H "Idempotency-Key: deposit-001" \
  -d '{"amountPaise":100000}'

curl -X POST localhost:3000/transfers \
  -H "Content-Type: application/json" -H "Idempotency-Key: transfer-001" \
  -d '{"fromAccountId":2,"toAccountId":3,"amountPaise":25050}'
```

## Data model

```
accounts        (id, owner_name, currency, balance_paise, is_system)
transactions    (id, type, from_account_id, to_account_id, amount_paise, idempotency_key UNIQUE, status)
ledger_entries  (id, transaction_id, account_id, amount_paise)   -- debit < 0, credit > 0
```

Deposits come from a special system account (`EXTERNAL_FUNDING`) so that deposits are double-entry too.

## Run locally

```bash
npm install
cp .env.example .env        # set DATABASE_URL to your PostgreSQL database
npm start                   # creates tables, then starts on port 3000
```

## Project structure

```
src/
  app.js       Express routes, input validation, error handling
  ledger.js    All money logic: locking, idempotency, double-entry
  db.js        Postgres pool and the withTransaction() helper
  schema.sql   Tables and constraints
  migrate.js   Applies schema.sql
test/
  api.test.js  Integration and concurrency tests (node:test)
```
