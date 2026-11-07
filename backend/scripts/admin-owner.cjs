// Create the admin panel owner, or set a new password for it.
//   npm run admin:owner -- you@example.com
// The password is typed at the prompt (not shown on screen). Only its hash is saved.
require('dotenv').config();
const readline = require('readline');
const db = require('../src/config/db');
const accounts = require('../src/services/adminAccounts');

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question('', answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const email = process.argv[2];
  if (!email) { console.error('Usage: npm run admin:owner -- you@example.com'); process.exitCode = 1; return; }
  const password = await askHidden(`Password for ${email} (at least ${accounts.MIN_PASSWORD} characters): `);
  await db();
  const { created, admin } = await accounts.setOwner({ email, password });
  console.log(created ? `Owner created: ${admin.email}` : `Owner password updated: ${admin.email} (other devices signed out)`);
})().catch(error => { console.error(`Could not set the owner (${error.code || error.message})`); process.exitCode = 1; })
  .finally(() => db.close().catch(() => {}));
