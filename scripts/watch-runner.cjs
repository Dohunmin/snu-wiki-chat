const { spawn } = require('child_process');
const path = require('path');

const cwd = path.join(__dirname, '..');

const proc = spawn('npx', ['tsx', '--env-file=.env.local', 'scripts/watch.ts'], {
  cwd,
  stdio: 'inherit',
  shell: true,
});

proc.on('close', code => process.exit(code ?? 0));
proc.on('error', err => { console.error(err); process.exit(1); });
