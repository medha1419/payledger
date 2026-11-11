const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  migrate()
    .then(() => { console.log('Migration complete'); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { migrate };
