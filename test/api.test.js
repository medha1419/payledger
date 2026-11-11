// Integration tests: start the real API against a real Postgres database.
// Run with: DATABASE_URL=postgres://.../payledger_test npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const app = require('../src/app');
const { pool } = require('../src/db');
const { migrate } = require('../src/migrate');

let server;
let base;

before(async () => {
  await pool.query('DROP TABLE IF EXISTS ledger_entries, transactions, accounts CASCADE');
  await migrate();
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

async function call(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const newAccount = async (name = 'Test User') => (await call('POST', '/accounts', { ownerName: name })).body;
const deposit = (id, amountPaise, key = randomUUID()) =>
  call('POST', `/accounts/${id}/deposits`, { amountPaise }, key);
const transfer = (fromAccountId, toAccountId, amountPaise, key = randomUUID()) =>
  call('POST', '/transfers', { fromAccountId, toAccountId, amountPaise }, key);
const balance = async (id) => (await call('GET', `/accounts/${id}`)).body.balancePaise;

test('creates an account with zero balance', async () => {
  const res = await call('POST', '/accounts', { ownerName: 'Medha' });
  assert.equal(res.status, 201);
  assert.equal(res.body.balancePaise, 0);
  assert.equal(res.body.currency, 'INR');
});

test('deposit increases balance', async () => {
  const a = await newAccount();
  const res = await deposit(a.id, 50000);
  assert.equal(res.status, 201);
  assert.equal(await balance(a.id), 50000);
});

test('transfer moves money and writes balanced ledger entries', async () => {
  const a = await newAccount('A');
  const b = await newAccount('B');
  await deposit(a.id, 10000);
  const res = await transfer(a.id, b.id, 2500);
  assert.equal(res.status, 201);
  assert.equal(await balance(a.id), 7500);
  assert.equal(await balance(b.id), 2500);

  // Double-entry invariant: every transaction's entries sum to zero.
  const { rows } = await pool.query(
    'SELECT transaction_id, SUM(amount_paise)::bigint AS total FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_paise) <> 0'
  );
  assert.equal(rows.length, 0);
});

test('insufficient funds is rejected and nothing changes', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 1000);
  const res = await transfer(a.id, b.id, 5000);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'INSUFFICIENT_FUNDS');
  assert.equal(await balance(a.id), 1000);
  assert.equal(await balance(b.id), 0);
});

test('retrying with the same Idempotency-Key moves money only once', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 10000);
  const key = randomUUID();
  const first = await transfer(a.id, b.id, 3000, key);
  const retry = await transfer(a.id, b.id, 3000, key);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(await balance(a.id), 7000);
  assert.equal(await balance(b.id), 3000);
});

test('reusing an Idempotency-Key for a different request returns 409', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 10000);
  const key = randomUUID();
  await transfer(a.id, b.id, 3000, key);
  const res = await transfer(a.id, b.id, 9999, key);
  assert.equal(res.status, 409);
  assert.equal(await balance(a.id), 7000);
});

test('20 concurrent transfers never overspend (no double-spend)', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 1000);
  // 20 requests of 100 paise each against a balance of 1000: exactly 10 may succeed.
  const results = await Promise.all(Array.from({ length: 20 }, () => transfer(a.id, b.id, 100)));
  const ok = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 422).length;
  assert.equal(ok, 10);
  assert.equal(rejected, 10);
  assert.equal(await balance(a.id), 0);
  assert.equal(await balance(b.id), 1000);
});

test('concurrent opposite-direction transfers do not deadlock', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 5000);
  await deposit(b.id, 5000);
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(transfer(a.id, b.id, 100));
    jobs.push(transfer(b.id, a.id, 100));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.status === 201));
  assert.equal((await balance(a.id)) + (await balance(b.id)), 10000);
});

test('the same Idempotency-Key sent concurrently creates one transaction', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 10000);
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => transfer(a.id, b.id, 1000, key)));
  const ids = new Set(results.map((r) => r.body.id));
  assert.equal(ids.size, 1);
  assert.equal(await balance(a.id), 9000);
});

test('transaction history shows debits and credits', async () => {
  const a = await newAccount();
  const b = await newAccount();
  await deposit(a.id, 5000);
  await transfer(a.id, b.id, 2000);
  const res = await call('GET', `/accounts/${a.id}/transactions`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((t) => [t.type, t.direction]), [
    ['TRANSFER', 'DEBIT'],
    ['DEPOSIT', 'CREDIT'],
  ]);
});

test('input validation', async () => {
  const a = await newAccount();
  const b = await newAccount();
  assert.equal((await transfer(a.id, b.id, -5)).status, 400);
  assert.equal((await transfer(a.id, b.id, 10.5)).status, 400);
  assert.equal((await transfer(a.id, a.id, 100)).status, 400);
  assert.equal((await call('POST', '/transfers', { fromAccountId: a.id, toAccountId: b.id, amountPaise: 100 })).status, 400); // no key
  assert.equal((await call('POST', '/accounts', {})).status, 400);
  assert.equal((await call('GET', '/accounts/999999')).status, 404);
  assert.equal((await transfer(a.id, 999999, 100)).status, 404);
});
