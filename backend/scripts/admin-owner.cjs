// Create the admin panel owner, or set a new password for it.
//   npm run admin:owner -- you@example.com
// The password is typed twice at the prompt (shown as *). Only its hash is saved.
require('dotenv').config();
const db = require('../src/config/db');
const accounts = require('../src/services/adminAccounts');

// Reads one line from the keyboard, showing * for each character.
// Handles Backspace and both Enter styles (\r, \n and Windows \r\n).
let pendingLf = false, leftover = '';
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(question);
    const raw = input.isTTY && typeof input.setRawMode === 'function';
    if (raw) input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let value = '';
    const done = result => {
      input.removeListener('data', onData);
      if (raw) input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      result instanceof Error ? reject(result) : resolve(result);
    };
    function onData(chunk) {
      const chars = [...(leftover + chunk)];
      leftover = '';
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '\n' && pendingLf) { pendingLf = false; continue; } // the \n of a \r\n
        pendingLf = false;
        if (ch === '\r' || ch === '\n') { pendingLf = ch === '\r'; leftover = chars.slice(i + 1).join(''); return done(value); }
        if (ch === '\u0003') return done(new Error('CANCELLED')); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch < ' ') continue; // other control keys
        value += ch;
        process.stdout.write('*');
      }
    }
    input.on('data', onData);
    if (leftover) onData('');
  });
}

(async () => {
  const email = process.argv[2];
  if (!email) { console.error('Usage: npm run admin:owner -- you@example.com'); process.exitCode = 1; return; }
  const password = await askHidden(`Password for ${email} (at least ${accounts.MIN_PASSWORD} characters): `);
  // Typed twice: the password is hidden, so a typo would otherwise go unnoticed.
  const again = await askHidden('Type the same password again: ');
  if (password !== again) { console.error('The two passwords are different. Nothing was changed; run the command again.'); process.exitCode = 1; return; }
  await db();
  const { created, admin } = await accounts.setOwner({ email, password });
  console.log(created ? `Owner created: ${admin.email}` : `Owner password updated: ${admin.email} (other devices signed out)`);
})().catch(error => { console.error(error.message === 'CANCELLED' ? 'Cancelled. Nothing was changed.' : `Could not set the owner (${error.code || error.message})`); process.exitCode = 1; })
  .finally(() => db.close().catch(() => {}));
