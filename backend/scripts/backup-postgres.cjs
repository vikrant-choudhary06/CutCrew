require('dotenv').config();
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL');
const url=new URL(process.env.DATABASE_URL);const dir=path.resolve(process.env.BACKUP_DIR||'.local/backups');fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,'cutcrew-'+new Date().toISOString().replace(/[:.]/g,'-')+'.dump');
const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGSSLMODE:url.searchParams.get('sslmode')||process.env.PGSSLMODE||'prefer'};
const executable=process.env.PG_DUMP_PATH||'pg_dump';
const child=spawn(executable,['--format=custom','--no-owner','--no-acl','--file',file],{env,shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.resume();child.on('error',()=>{console.error('Backup tool unavailable. Set PG_DUMP_PATH.');process.exitCode=1});child.on('close',code=>{if(code){console.error('Backup failed. Check database permissions and tool version.');process.exitCode=1}else console.log('Backup saved:',file)});
