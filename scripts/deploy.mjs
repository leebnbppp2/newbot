import { spawn } from 'node:child_process';
import fs from 'node:fs';

const mode = process.argv[2] ?? 'build';
const requiredSecrets = ['TELEGRAM_WEBHOOK_SECRET', 'BOT_TOKEN_CRYPTO_ZH'];

assertFile('wrangler.jsonc');
assertFile('migrations/0001_init.sql');
assertSecretsDocumented(requiredSecrets);

const args = mode === 'deploy'
  ? ['wrangler', 'deploy', '--config', 'wrangler.jsonc']
  : ['wrangler', 'deploy', '--dry-run', '--config', 'wrangler.jsonc'];

await run('npx', args);

function assertFile(path) {
  if (!fs.existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }
}

function assertSecretsDocumented(secretNames) {
  const readme = fs.readFileSync('README.md', 'utf8');
  for (const secretName of secretNames) {
    if (!readme.includes(secretName)) {
      throw new Error(`README.md must document secret: ${secretName}`);
    }
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
    child.on('error', reject);
  });
}
