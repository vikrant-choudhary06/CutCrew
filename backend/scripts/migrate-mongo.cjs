require('dotenv').config();
const { MongoClient } = require('mongodb');
const db = require('../src/config/db');
const { importRecords } = require('../src/services/databaseImport');

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw new Error('Use --dry-run (default) or --apply');
  if (!process.env.SOURCE_MONGO_URI) throw new Error('Set SOURCE_MONGO_URI to the source database; use a read-only MongoDB account');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the target PostgreSQL database');
  const mongo = new MongoClient(process.env.SOURCE_MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await mongo.connect();
    await db();
    const source = mongo.db(process.env.SOURCE_MONGO_DATABASE || undefined);
    const result = await importRecords({
      movies: source.collection('movies').find({}).batchSize(100),
      users: source.collection('users').find({}).batchSize(100),
      apply: args.includes('--apply'),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await mongo.close(); await db.close(); }
}
main().catch(error => {
  // Do not emit connection strings, user passwords or cached provider URLs.
  console.error(`Migration failed (${error.code || error.name || 'error'}). No import transaction was committed.`);
  if (error.message.startsWith('Set ') || error.message.startsWith('Use ')) console.error(error.message);
  process.exitCode = 1;
});
