// All money logic lives here. Routes in app.js only validate input and call these.
const { pool, withTransaction } = require('./db');
const { AppError } = require('./errors');

const toAccount = (row) => ({
  id: Number(row.id),
  ownerName: row.owner_name,
  currency: row.currency,
  balancePaise: Number(row.balance_paise),
  createdAt: row.created_at,
});

const toTransaction = (row) => ({
  id: Number(row.id),
  type: row.type,
  fromAccountId: Number(row.from_account_id),
  toAccountId: Number(row.to_account_id),
  amountPaise: Number(row.amount_paise),
  status: row.status,
  createdAt: row.created_at,
});

async function createAccount(ownerName) {
  const { rows } = await pool.query(
    'INSERT INTO accounts (owner_name) VALUES ($1) RETURNING *',
    [ownerName]
  );
  return toAccount(rows[0]);
}

async function getAccount(id) {
  const { rows } = await pool.query(
    'SELECT * FROM accounts WHERE id = $1 AND NOT is_system',
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${id} not found`);
  return toAccount(rows[0]);
}

async function getSystemAccountId(client) {
  const { rows } = await client.query('SELECT id FROM accounts WHERE is_system LIMIT 1');
  return Number(rows[0].id);
}

/**
 * Moves money from one account to another, exactly once.
 *
 * 1. Locking FIRST: SELECT ... FOR UPDATE on both accounts, always in ascending id order.
 *    Concurrent requests touching the same account wait in line (no double-spend), and the
 *    fixed lock order means two opposite transfers (A->B and B->A) cannot deadlock.
 *    (Locks must come before the INSERT below: the INSERT's foreign keys take a shared
 *    lock on the account rows, and two requests that both hold that shared lock and then
 *    both ask for FOR UPDATE deadlock each other. The tests caught exactly this.)
 * 2. Idempotency: insert the transaction row. If the idempotency key already exists,
 *    this is a retry, so return the original result instead of moving money again.
 * 3. Check funds, update both balances, write the debit and credit ledger entries.
 * All of this runs in one database transaction: it fully happens or not at all.
 */
async function moveMoney({ type, fromAccountId, toAccountId, amountPaise, idempotencyKey }) {
  return withTransaction(async (client) => {
    if (fromAccountId === null) fromAccountId = await getSystemAccountId(client);

    // Lock both rows in a fixed order (lowest id first) to avoid deadlocks.
    const { rows: locked } = await client.query(
      'SELECT * FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [[fromAccountId, toAccountId]]
    );
    const from = locked.find((a) => Number(a.id) === fromAccountId);
    const to = locked.find((a) => Number(a.id) === toAccountId);
    if (!from || (type === 'TRANSFER' && from.is_system)) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${fromAccountId} not found`);
    }
    if (!to || to.is_system) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${toAccountId} not found`);
    }

    const inserted = await client.query(
      `INSERT INTO transactions (type, from_account_id, to_account_id, amount_paise, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [type, fromAccountId, toAccountId, amountPaise, idempotencyKey]
    );

    if (inserted.rows.length === 0) {
      // Key already used: this is a retry of an earlier request.
      const { rows } = await client.query(
        'SELECT * FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      const existing = toTransaction(rows[0]);
      const samePayload =
        existing.type === type &&
        existing.fromAccountId === fromAccountId &&
        existing.toAccountId === toAccountId &&
        existing.amountPaise === amountPaise;
      if (!samePayload) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request');
      }
      return { transaction: existing, replayed: true };
    }

    const txn = toTransaction(inserted.rows[0]);

    if (!from.is_system && Number(from.balance_paise) < amountPaise) {
      throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    }

    await client.query(
      'UPDATE accounts SET balance_paise = balance_paise - $1 WHERE id = $2',
      [amountPaise, fromAccountId]
    );
    await client.query(
      'UPDATE accounts SET balance_paise = balance_paise + $1 WHERE id = $2',
      [amountPaise, toAccountId]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount_paise)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [txn.id, fromAccountId, -amountPaise, toAccountId, amountPaise]
    );

    return { transaction: txn, replayed: false };
  });
}

function deposit(accountId, amountPaise, idempotencyKey) {
  return moveMoney({ type: 'DEPOSIT', fromAccountId: null, toAccountId: accountId, amountPaise, idempotencyKey });
}

function transfer(fromAccountId, toAccountId, amountPaise, idempotencyKey) {
  if (fromAccountId === toAccountId) {
    throw new AppError(400, 'SAME_ACCOUNT', 'Cannot transfer to the same account');
  }
  return moveMoney({ type: 'TRANSFER', fromAccountId, toAccountId, amountPaise, idempotencyKey });
}

async function getHistory(accountId, limit = 50) {
  await getAccount(accountId); // 404 if missing
  const { rows } = await pool.query(
    `SELECT e.amount_paise AS entry_paise, t.*
       FROM ledger_entries e
       JOIN transactions t ON t.id = e.transaction_id
      WHERE e.account_id = $1
      ORDER BY e.id DESC
      LIMIT $2`,
    [accountId, limit]
  );
  return rows.map((r) => ({
    ...toTransaction(r),
    direction: Number(r.entry_paise) < 0 ? 'DEBIT' : 'CREDIT',
  }));
}

module.exports = { createAccount, getAccount, deposit, transfer, getHistory };
