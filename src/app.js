const express = require('express');
const ledger = require('./ledger');
const { AppError } = require('./errors');

const app = express();
app.use(express.json());

// Express 4 does not catch errors from async handlers, so wrap them.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- input validation helpers ----------
function parseId(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AppError(400, 'INVALID_INPUT', `${name} must be a positive integer`);
  }
  return n;
}

function parseAmount(value) {
  // Amounts are whole paise only: 150050 = Rs 1500.50
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(400, 'INVALID_INPUT', 'amountPaise must be a positive whole number');
  }
  return value;
}

function requireIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length > 100) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header (max 100 chars)');
  }
  return key;
}

// ---------- routes ----------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/accounts', route(async (req, res) => {
  const ownerName = typeof req.body.ownerName === 'string' ? req.body.ownerName.trim() : '';
  if (!ownerName) throw new AppError(400, 'INVALID_INPUT', 'ownerName is required');
  res.status(201).json(await ledger.createAccount(ownerName));
}));

app.get('/accounts/:id', route(async (req, res) => {
  res.json(await ledger.getAccount(parseId(req.params.id, 'id')));
}));

app.get('/accounts/:id/transactions', route(async (req, res) => {
  res.json(await ledger.getHistory(parseId(req.params.id, 'id')));
}));

app.post('/accounts/:id/deposits', route(async (req, res) => {
  const key = requireIdempotencyKey(req);
  const { transaction, replayed } = await ledger.deposit(
    parseId(req.params.id, 'id'), parseAmount(req.body.amountPaise), key
  );
  res.status(replayed ? 200 : 201).json(transaction);
}));

app.post('/transfers', route(async (req, res) => {
  const key = requireIdempotencyKey(req);
  const { transaction, replayed } = await ledger.transfer(
    parseId(req.body.fromAccountId, 'fromAccountId'),
    parseId(req.body.toAccountId, 'toAccountId'),
    parseAmount(req.body.amountPaise),
    key
  );
  res.status(replayed ? 200 : 201).json(transaction);
}));

// ---------- error handling ----------
app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body is not valid JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
});

module.exports = app;
