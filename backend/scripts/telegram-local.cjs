// Run the official, locally built server in WSL. Secrets travel over stdin,
// never in the command line or terminal output. Keep this process running.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const poc = require('../src/services/telegramStorage');
require('dotenv').config({path:path.join(poc.ROOT,'.env'),quiet:true});
const config = poc.configuration();
if (!config.ready) {
  console.log(JSON.stringify({status:'blocked-configuration',missing:config.missing,errors:config.errors}));
  process.exit(2);
}
if (config.baseUrl !== 'http://127.0.0.1:8081') {
  console.log(JSON.stringify({status:'failed',code:'LOCAL_LAUNCHER_REQUIRES_DEFAULT_LOOPBACK_PORT'}));
  process.exit(2);
}
const native = path.join(poc.ROOT,'.local/telegram/native');
const binary = path.join(native,'source/build/telegram-bot-api');
if (!fs.existsSync(binary)) {
  console.log(JSON.stringify({status:'failed',code:'LOCAL_BINARY_NOT_BUILT'}));
  process.exit(2);
}
fs.mkdirSync(native,{recursive:true,mode:0o700});
const log = fs.openSync(path.join(native,'server.private.log'),'a',0o600);
const linuxPath = value => '/mnt/' + value[0].toLowerCase() + value.slice(2).replaceAll('\\','/');
// Server data must live on the Linux filesystem: its database renames files,
// which fails on the Windows/OneDrive mount (and OneDrive would sync the
// session data, whose folder is named after the bot token, to the cloud).
const dataDir = process.env.TELEGRAM_LOCAL_DATA_DIR || '~/.local/share/cutcrew-telegram-bot-api';
if (!/^(~|\/home\/[a-z_][a-z0-9_-]*|\/var\/lib)(\/[\w.-]+)+$/.test(dataDir)) {
  console.log(JSON.stringify({status:'failed',code:'TELEGRAM_LOCAL_DATA_DIR_INVALID'}));
  process.exit(2);
}
const program = 'import sys,json,os\np=json.loads(sys.stdin.readline())\nos.umask(0o077)\nw=os.path.expanduser(p["work"])\nos.makedirs(w,exist_ok=True)\nos.chdir(w)\ne=os.environ.copy()\ne["TELEGRAM_API_ID"]=p["id"]\ne["TELEGRAM_API_HASH"]=p["hash"]\nos.execve(p["binary"],[p["binary"],"--local","--dir="+w,"--http-ip-address=127.0.0.1","--http-port=8081","--verbosity=0"],e)';
const child = spawn('wsl.exe',['-d','Ubuntu','--','python3','-c',program],{stdio:['pipe',log,log],windowsHide:true});
child.on('error',()=>{console.log(JSON.stringify({status:'failed',code:'LOCAL_SERVER_LAUNCH_FAILED'}));process.exitCode=1;});
child.stdin.on('error',()=>{});
child.stdin.end(JSON.stringify({id:String(config.apiId),hash:config.apiHash,binary:linuxPath(binary),work:dataDir})+'\n');
console.log(JSON.stringify({status:'local-server-launch-requested',url:config.baseUrl,logs:'private ignored local directory',note:'Run telegram:check separately to verify readiness.'}));
child.on('exit',code=>{fs.closeSync(log);console.log(JSON.stringify({status:'local-server-exited',exitCode:code}));process.exitCode=code||0;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill());
