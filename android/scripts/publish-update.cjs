#!/usr/bin/env node
// Publishes an over-the-air (JavaScript) update of the Android app to
// CutCrew's own update server (backend /api/updates/*).
//
//   node scripts/publish-update.cjs            # export, upload, done
//   node scripts/publish-update.cjs --dry-run  # export only (dist-update/)
//
// Phones with the same native version (runtimeVersion = app.json "version")
// pick it up the next time they open the app, and run it the time after.
// A new native version (new APK) needs a new release instead.
//
// Upload settings (no secrets are stored here):
//   CUTCREW_SSH_KEY   path to the server's SSH key file
//   CUTCREW_SSH_HOST  default ubuntu@3.25.211.1
//   CUTCREW_DIR       project folder on the server, default ~/cutcrew
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appDir = path.resolve(__dirname, '..');
const out = path.join(appDir, 'dist-update');
const config = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8')).expo;
const runtimeVersion = config.version;
const now = new Date();
const folder = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dryRun = process.argv.includes('--dry-run');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', cwd: appDir, shell: process.platform === 'win32', encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return result.stdout;
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`Exporting the Android bundle for runtime version ${runtimeVersion}…`);
run('npx', ['expo', 'export', '--platform', 'android', '--output-dir', 'dist-update']);
fs.writeFileSync(path.join(out, 'expoConfig.json'), run('npx', ['expo', 'config', '--json', '--type', 'public'], { capture: true }));
if (!fs.existsSync(path.join(out, 'metadata.json'))) throw new Error('expo export did not write metadata.json');
// On Windows, expo export writes asset paths with backslashes; the server uses '/'.
const metaFile = path.join(out, 'metadata.json');
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
for (const platform of Object.values(meta.fileMetadata || {})) {
  platform.bundle = platform.bundle.replace(/\\/g, '/');
  for (const item of platform.assets || []) item.path = item.path.replace(/\\/g, '/');
}
fs.writeFileSync(metaFile, JSON.stringify(meta));
console.log(`Update ready in dist-update/ (folder ${runtimeVersion}/${folder}).`);
if (dryRun) process.exit(0);

const key = process.env.CUTCREW_SSH_KEY;
if (!key) throw new Error('Set CUTCREW_SSH_KEY to the server SSH key file to upload.');
const host = process.env.CUTCREW_SSH_HOST || 'ubuntu@3.25.211.1';
const remoteDir = process.env.CUTCREW_DIR || '~/cutcrew';
// Relative paths: tar and scp read 'C:' in a Windows path as a host name.
const archive = 'dist-update.tgz';
run('tar', ['czf', archive, '-C', 'dist-update', '.']);
const ssh = ['-i', key, '-o', 'BatchMode=yes'];
run('scp', [...ssh, '-q', archive, `${host}:/tmp/cutcrew-update.tgz`]);
// The update folder lives on the backend's data volume (/app/backend/.local).
const target = `/app/backend/.local/updates/${runtimeVersion}/${folder}`;
run('ssh', [...ssh, host, [
  'set -e', `cd ${remoteDir}`, 'rm -rf /tmp/cutcrew-update', 'mkdir -p /tmp/cutcrew-update', 'tar xzf /tmp/cutcrew-update.tgz -C /tmp/cutcrew-update',
  'C=$(sudo docker compose -f compose.yaml -f deploy/compose.domains.yaml ps -q backend)',
  `sudo docker exec $C mkdir -p ${target}`, `sudo docker cp /tmp/cutcrew-update/. $C:${target}`, `sudo docker exec -u 0 $C chown -R node:node /app/backend/.local/updates`,
  'rm -rf /tmp/cutcrew-update /tmp/cutcrew-update.tgz', `echo published ${runtimeVersion}/${folder}`,
].join('; ')]);
fs.rmSync(path.join(appDir, archive), { force: true });
