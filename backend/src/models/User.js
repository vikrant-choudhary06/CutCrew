const db = require('../config/db');
const { randomUUID } = require('node:crypto');
module.exports = {
  async countDocuments() { return Number((await db.query('SELECT count(*) AS count FROM users')).rows[0].count); },
  async create(input) {
    const result = await db.query(`INSERT INTO users(id, email, password, role, created_at, updated_at)
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), COALESCE($6::timestamptz, now())) RETURNING *`,
    [input._id?.toString() || randomUUID(), input.email, input.password, input.role || 'user', input.createdAt || null, input.updatedAt || null]);
    const row = result.rows[0];
    return { _id: row.id, email: row.email, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at };
  },
};
