// Control the isolated native cluster created for local development.
// Never touches the system PostgreSQL service or any configured remote database.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const action = process.argv[2] || 'status';
if (!['start', 'stop', 'status'].includes(action)) throw new Error('Use start, stop or status');
const data = path.resolve(__dirname, '../.local/native-postgres');
if (!fs.existsSync(path.join(data, 'PG_VERSION'))) throw new Error('No isolated local cluster exists here; use your PostgreSQL service or the Docker setup documented in README.md');
const executable = process.env.POSTGRES_BIN
  ? path.join(process.env.POSTGRES_BIN, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl')
  : process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' : 'pg_ctl';
const args = ['-D', data];
if (action === 'start') args.push('-l', path.resolve(__dirname, '../.local/postgres.log'), '-o', '-h 127.0.0.1 -p 15432', '-w');
if (action === 'stop') args.push('-m', 'fast', '-w');
args.push(action);
const result = spawnSync(executable, args, { windowsHide: true, stdio: 'inherit', timeout: 90000 });
if (result.error) { console.error('Local database control failed:', result.error.code); process.exitCode = 1; }
else process.exitCode = result.status || 0;
