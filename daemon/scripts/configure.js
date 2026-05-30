#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
let panel = '';
let key = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--panel') panel = args[++i];
  else if (args[i] === '--key') key = args[++i];
}

if (!panel || !key) {
  console.error('Usage: npm run configure -- --panel <url> --key <key>');
  process.exit(1);
}

const env = `remote=${panel}
key=${key}
port=3002
DEBUG=false
version=1.0.0
environment=production
STATS_INTERVAL=10000
`;

fs.writeFileSync('.env', env);
console.log('Daemon configured. Restarting service...');

try {
  execSync('systemctl restart sodium-daemon', { stdio: 'inherit' });
  console.log('sodium-daemon restarted successfully.');
} catch {
  console.log('Could not restart service (not running as root?).');
}
