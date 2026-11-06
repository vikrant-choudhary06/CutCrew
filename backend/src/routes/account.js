const router = require('express').Router();
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const db = require('../config/db');
const mail = require('../services/accountMail');
const allowed = () => (process.env.FRONTEND_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(x => x.trim());
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const attempts = new Map();
router.use((req,res,next) => {
  res.set('Cache-Control','no-store');
  if (req.method !== 'GET' && req.get('origin') && !allowed().includes(req.get('origin'))) return res.status(403).json({ message: 'Origin is not allowed' });
  next();
});
async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;
}
async function passwordValid(password, stored) {
  const [version,salt,digest] = stored.split(':');
  if (version !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/.test(digest || '')) return false;
  return equal((await scrypt(password,salt,64)).toString('hex'),digest);
}
function credentials(req,res,next) {
  const email = req.body.email, password = req.body.password;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 128) return res.status(400).json({ message: 'Enter a valid email and a password of 12–128 characters' });
  req.body.email = email.trim().toLowerCase();
  const now = Date.now(), key = req.ip;
  if (attempts.size > 10000) for (const [id,record] of attempts) if (record.until < now) attempts.delete(id);
  const record = attempts.get(key);
  if (record && record.until > now && record.count >= 10) return res.status(429).json({ message: 'Too many attempts. Try again in 15 minutes.' });
  attempts.set(key, record && record.until > now ? { ...record, count: record.count + 1 } : { until: now + 900000, count: 1 });
  next();
}
async function session(req,res,user) {
  const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES ($1,$2,$3,$4)', [sha(token),user.id,csrf,new Date(Date.now()+30*86400000)]);
  res.cookie('cutcrew_session',token,{ httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:'lax', path:'/api/account', maxAge:30*86400000 });
  res.json({ user:{ id:user.id,email:user.email,emailVerified:!!user.email_verified_at }, csrf, profiles:(await db.query('SELECT id,name FROM profiles WHERE user_id=$1 ORDER BY created_at,id',[user.id])).rows });
}
router.post('/register',credentials,async(req,res,next)=>{
  try {
    const id=crypto.randomUUID(), hash=await passwordHash(req.body.password);
    const user=await db.transaction(async client=>{
      if ((await client.query('SELECT id FROM users WHERE lower(email)=$1',[req.body.email])).rows.length) throw Object.assign(new Error('Email already registered'),{status:409});
      const row=(await client.query('INSERT INTO users(id,email,password) VALUES ($1,$2,$3) RETURNING id,email',[id,req.body.email,hash])).rows[0];
      await client.query('INSERT INTO profiles(id,user_id,name) VALUES ($1,$2,$3)',[crypto.randomUUID(),id,'My profile']); return row;
    });
    await mail.issue(user,'verify');
    await session(req,res,user);
  } catch(error){if(error.code==='23505')error=Object.assign(new Error('Email already registered'),{status:409});next(error);}
});
router.post('/login',credentials,async(req,res,next)=>{
  try {
    const user=(await db.query('SELECT id,email,password,email_verified_at FROM users WHERE lower(email)=$1',[req.body.email])).rows[0];
    // Hash even unknown-account attempts to reduce timing differences.
    const hash=user?.password || 'scrypt:00000000000000000000000000000000:'+'0'.repeat(128);
    if (!await passwordValid(req.body.password,hash) || !user) return res.status(401).json({ message:'Email or password is incorrect' });
    if (!(await db.query('SELECT id FROM profiles WHERE user_id=$1',[user.id])).rows.length) await db.query('INSERT INTO profiles(id,user_id,name) VALUES ($1,$2,$3)',[crypto.randomUUID(),user.id,'My profile']);
    await session(req,res,user);
  } catch(error){next(error);}
});
const recoveryAttempts=new Map();
function recoveryLimit(req,res,next){const key=req.ip,now=Date.now();if(recoveryAttempts.size>10000)for(const [k,v]of recoveryAttempts)if(v.until<now)recoveryAttempts.delete(k);const old=recoveryAttempts.get(key);if(old&&old.until>now&&old.count>=20)return res.status(429).json({message:'Too many requests. Try again in 15 minutes.'});recoveryAttempts.set(key,old&&old.until>now?{...old,count:old.count+1}:{count:1,until:now+900000});next();}
router.post('/forgot-password',recoveryLimit,async(req,res,next)=>{try{
  if(!mail.configuration())return res.status(503).json({message:'Email delivery is not configured yet. Please contact the site owner.'});
  const email=typeof req.body.email==='string'?req.body.email.trim().toLowerCase():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({message:'Enter a valid email'});
  const user=(await db.query('SELECT id,email FROM users WHERE lower(email)=$1',[email])).rows[0];
  if(user)await mail.issue(user,'reset');
  res.json({message:'If this account exists, a reset link will be sent. Check your inbox and spam folder.'});
}catch(e){next(e);}});
router.post('/reset-password',recoveryLimit,async(req,res,next)=>{try{
  const {token,password}=req.body;
  if(!/^[a-f0-9]{64}$/.test(token||'')||typeof password!=='string'||password.length<12||password.length>128)return res.status(400).json({message:'Use a valid reset link and a password of 12-128 characters'});
  const hash=await passwordHash(password);
  await db.transaction(async client=>{
    const row=(await client.query("SELECT * FROM account_tokens WHERE token_hash=$1 AND purpose='reset' AND expires_at>now() FOR UPDATE",[sha(token)])).rows[0];
    if(!row)throw Object.assign(new Error('This link is invalid or expired. Request a new one.'),{status:400});
    await client.query('UPDATE users SET password=$1,updated_at=now() WHERE id=$2',[hash,row.user_id]);
    await client.query('DELETE FROM sessions WHERE user_id=$1',[row.user_id]);
    await client.query("DELETE FROM account_tokens WHERE user_id=$1 AND purpose='reset'",[row.user_id]);
  });res.clearCookie('cutcrew_session',{path:'/api/account'});res.json({message:'Password updated. Sign in with your new password.'});
}catch(e){next(e);}});
router.post('/verify-email',recoveryLimit,async(req,res,next)=>{try{
  const token=req.body.token;if(!/^[a-f0-9]{64}$/.test(token||''))return res.status(400).json({message:'Invalid verification link'});
  await db.transaction(async client=>{const row=(await client.query("SELECT * FROM account_tokens WHERE token_hash=$1 AND purpose='verify' AND expires_at>now() FOR UPDATE",[sha(token)])).rows[0];if(!row)throw Object.assign(new Error('This link is invalid or expired. Request a new one.'),{status:400});await client.query('UPDATE users SET email_verified_at=now(),updated_at=now() WHERE id=$1',[row.user_id]);await client.query("DELETE FROM account_tokens WHERE user_id=$1 AND purpose='verify'",[row.user_id]);});res.json({message:'Email verified. You can return to your account.'});
}catch(e){next(e);}});
router.use(async(req,res,next)=>{
  try {
    const token=(req.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('cutcrew_session='))?.slice(16);
    if(!token || !/^[a-f0-9]{64}$/.test(token))return res.status(401).json({message:'Sign in to continue'});
    const row=(await db.query('SELECT s.*,u.email,u.email_verified_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now()',[sha(token)])).rows[0];
    if(!row)return res.status(401).json({message:'Your session has expired. Sign in again.'});
    if(req.method!=='GET' && !equal(req.get('x-csrf-token'),row.csrf))return res.status(403).json({message:'Refresh your session and retry'});
    req.account=row;next();
  }catch(error){next(error);}
});
router.get('/me',async(req,res,next)=>{try{res.json({user:{id:req.account.user_id,email:req.account.email,emailVerified:!!req.account.email_verified_at},csrf:req.account.csrf,profiles:(await db.query('SELECT id,name FROM profiles WHERE user_id=$1 ORDER BY created_at,id',[req.account.user_id])).rows});}catch(e){next(e);}});
router.post('/logout',async(req,res,next)=>{try{await db.query('DELETE FROM sessions WHERE token_hash=$1',[req.account.token_hash]);res.clearCookie('cutcrew_session',{path:'/api/account'});res.json({ok:true});}catch(e){next(e);}});
router.post('/send-verification',recoveryLimit,async(req,res,next)=>{try{if(req.account.email_verified_at)return res.json({message:'Email already verified'});if(!mail.configuration())return res.status(503).json({message:'Email delivery is not configured yet. Please contact the site owner.'});if(!await mail.issue({id:req.account.user_id,email:req.account.email},'verify'))return res.status(503).json({message:'Email delivery failed. Please try again later.'});res.json({message:'Verification link sent. Check your inbox.'});}catch(e){next(e);}});
router.post('/profiles',async(req,res,next)=>{try{
  const name=req.body.name;if(typeof name!=='string'||!name.trim()||name.trim().length>40)return res.status(400).json({message:'Profile name must be 1–40 characters'});
  const row=await db.transaction(async client=>{await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.account.user_id]);if((await client.query('SELECT id FROM profiles WHERE user_id=$1',[req.account.user_id])).rows.length>=5)throw Object.assign(new Error('You can create up to 5 profiles'),{status:400});return(await client.query('INSERT INTO profiles(id,user_id,name) VALUES ($1,$2,$3) RETURNING id,name',[crypto.randomUUID(),req.account.user_id,name.trim()])).rows[0];});res.json(row);
}catch(e){next(e);}});
router.use(async(req,res,next)=>{try{
  const id=req.get('x-profile-id');
  const profile=(await db.query('SELECT id FROM profiles WHERE user_id=$1 AND id=$2',[req.account.user_id,id||''])).rows[0];
  if(!profile)return res.status(403).json({message:'Choose one of your profiles'});req.profileId=profile.id;next();
}catch(e){next(e);}});
router.get('/library',async(req,res,next)=>{try{
  const watchlist=(await db.query('SELECT data FROM watchlist WHERE profile_id=$1 ORDER BY updated_at DESC',[req.profileId])).rows.map(x=>x.data);
  const progress=(await db.query('SELECT imdb_id,season,episode,position,duration,completed,data,updated_at,observed_at FROM progress WHERE profile_id=$1 ORDER BY updated_at DESC LIMIT 200',[req.profileId])).rows;
  res.json({watchlist,progress});
}catch(e){next(e);}});
function titleData(data){if(!data||!/^(tt\d{5,12}|anilist:\d{1,9})$/.test(data.imdb_id||'')||typeof data.title!=='string'||!data.title.trim()||data.title.length>300)throw Object.assign(new Error('Invalid title'),{status:400});return{imdb_id:data.imdb_id,title:data.title,poster_url:typeof data.poster_url==='string'?data.poster_url.slice(0,2000):'',release_year:Number(data.release_year)||null,title_type:typeof data.title_type==='string'?data.title_type.slice(0,50):'Movie'};}
router.put('/watchlist',async(req,res,next)=>{try{const data=titleData(req.body);await db.query('INSERT INTO watchlist(profile_id,imdb_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT(profile_id,imdb_id) DO UPDATE SET data=$3::jsonb,updated_at=now()',[req.profileId,data.imdb_id,JSON.stringify(data)]);res.json({ok:true});}catch(e){next(e);}});
router.delete('/watchlist/:id',async(req,res,next)=>{try{await db.query('DELETE FROM watchlist WHERE profile_id=$1 AND imdb_id=$2',[req.profileId,req.params.id]);res.json({ok:true});}catch(e){next(e);}});
router.put('/progress',async(req,res,next)=>{try{
  const data=titleData(req.body.data),{position,duration,season=0,episode=0,completed=false}=req.body;
  if(typeof position!=='number'||!Number.isFinite(position)||position<0||position>172800||(duration!==null&&duration!==undefined&&(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0||duration>172800))||!Number.isInteger(season)||season<0||season>1000||!Number.isInteger(episode)||episode<0||episode>10000||typeof completed!=='boolean')return res.status(400).json({message:'Invalid playback progress'});
  const recordedAt=req.body.recordedAt?new Date(req.body.recordedAt):new Date();
  if(!Number.isFinite(recordedAt.getTime())||recordedAt.getTime()>Date.now()+300000||recordedAt.getFullYear()<2000)return res.status(400).json({message:'Invalid progress timestamp'});
  await db.query('INSERT INTO progress(profile_id,imdb_id,season,episode,position,duration,completed,data,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(profile_id,imdb_id,season,episode) DO UPDATE SET position=$5,duration=$6,completed=$7,data=$8::jsonb,observed_at=$9,updated_at=now() WHERE progress.observed_at <= EXCLUDED.observed_at',[req.profileId,data.imdb_id,season,episode,position,duration||null,completed,JSON.stringify(data),recordedAt]);res.json({ok:true});
}catch(e){next(e);}});
router.delete('/progress/:id',async(req,res,next)=>{try{await db.query('DELETE FROM progress WHERE profile_id=$1 AND imdb_id=$2',[req.profileId,req.params.id]);res.json({ok:true});}catch(e){next(e);}});
module.exports=router;
module.exports.passwordHash=passwordHash;module.exports.passwordValid=passwordValid;
