require('dotenv').config();
const db = require('../src/config/db');
(async () => {
  try {
    await db();
    const result = await db.query('SELECT (SELECT count(*) FROM movies) AS movies, (SELECT count(*) FROM users) AS users');
    console.log('PostgreSQL connected; schema ready:', result.rows[0]);
  } finally { await db.close(); }
})().catch(error => { console.error(`PostgreSQL check failed (${error.code || error.name})`); process.exitCode = 1; });
