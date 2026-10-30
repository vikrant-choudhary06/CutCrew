const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../config/db');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function configuration() {
  if (process.env.MAIL_TRANSPORT === 'file' && process.env.NODE_ENV !== 'production') return 'file';
  if (process.env.SMTP_HOST && process.env.MAIL_FROM && process.env.APP_URL) return 'smtp';
  return null;
}
async function issue(user, purpose) {
  const transport = configuration();
  if (!transport) return false;
  const token = crypto.randomBytes(32).toString('hex');
  const origin = new URL(process.env.APP_URL || 'http://localhost:5173');
  if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Invalid APP_URL');
  origin.hash = new URLSearchParams({account:purpose,token}).toString();
  const message = {from:process.env.MAIL_FROM || 'CutCrew <local@example.test>', to:user.email,
    subject:purpose === 'reset' ? 'Reset your CutCrew password' : 'Verify your CutCrew email',
    text:`${purpose === 'reset' ? 'Reset your password' : 'Verify your email'}: ${origin.href}\n\nThis link expires in ${purpose === 'reset' ? '30 minutes' : '24 hours'} and works once. If you did not request it, ignore this email.`};
  await db.transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    await client.query('DELETE FROM account_tokens WHERE user_id=$1 AND purpose=$2',[user.id,purpose]);
    await client.query('INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,$4)',[hash(token),user.id,purpose,new Date(Date.now()+(purpose==='reset'?1800000:86400000))]);
  });
  try {
    if (transport === 'file') {
      const directory=process.env.MAIL_DIRECTORY || path.join(__dirname,'../../.local/mail');
      await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(path.join(directory,crypto.randomUUID()+'.json'),JSON.stringify(message,null,2),{mode:0o600,flag:'wx'});
    } else {
      const mailer=require('nodemailer').createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT)||587,
        secure:process.env.SMTP_SECURE==='true',requireTLS:process.env.SMTP_SECURE!=='true',
        ...(process.env.SMTP_USER?{auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}}:{}),
        connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
      await mailer.sendMail(message);
    }
    return true;
  } catch {
    await db.query('DELETE FROM account_tokens WHERE token_hash=$1',[hash(token)]);
    // Never log credentials, addresses or recovery URLs.
    console.error('Account email delivery failed');
    return false;
  }
}
module.exports={configuration,issue,hash};
