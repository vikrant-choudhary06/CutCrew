const db = require('../src/config/db');
module.exports = async () => {
  if (!process.env.TEST_DATABASE_URL) return db({ embedded: true });
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!/^\/cutcrew_test_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('Native tests require a separate empty database named cutcrew_test_<suffix>');
  }
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  return db();
};
