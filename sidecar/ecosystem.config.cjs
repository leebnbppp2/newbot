// pm2 process manifest for the NewBot stack on polybot (Seoul).
// Replaces the hand-run tmux sessions (wgl/osvc/ng) with supervised, auto-restarting,
// reboot-surviving processes, plus a self-healing Telegram webhook updater (hook).
//   pm2 start ecosystem.config.cjs && pm2 save
const HOME = '/home/ubuntu';
const NODE = `${HOME}/.nvm/versions/node/v22.23.1/bin/node`;
const NPX = `${HOME}/.nvm/versions/node/v22.23.1/bin/npx`;
const CWD = `${HOME}/newbot`;

module.exports = {
  apps: [
    {
      name: 'osvc', // order-service sidecar (@polymarket/client SecureClient + auto-wrap) on :8799
      cwd: CWD,
      script: 'order_service.mjs',
      interpreter: NODE,
      interpreter_args: '--env-file=.dev.vars',
      autorestart: true,
      max_restarts: 50,
      out_file: `${CWD}/osvc.log`,
      error_file: `${CWD}/osvc.log`,
      merge_logs: true,
    },
    {
      name: 'wgl', // the Cloudflare Worker (wrangler dev --local) on :8787
      cwd: CWD,
      script: NPX,
      args: 'wrangler dev --local --port 8787',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 50,
      out_file: `${CWD}/wgl.log`,
      error_file: `${CWD}/wgl.log`,
      merge_logs: true,
    },
    {
      name: 'ng', // ngrok tunnel -> :8787 (public HTTPS for the Telegram webhook)
      cwd: CWD,
      script: `${HOME}/ngrok`,
      args: 'http 8787 --log stdout',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 50,
      out_file: `${CWD}/ngrok.log`,
      error_file: `${CWD}/ngrok.log`,
      merge_logs: true,
    },
    {
      name: 'hook', // self-healing Telegram webhook: re-points when ngrok's URL changes
      cwd: CWD,
      script: 'webhook_updater.mjs',
      interpreter: NODE,
      interpreter_args: '--env-file=.dev.vars',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: `${CWD}/hook.log`,
      error_file: `${CWD}/hook.log`,
      merge_logs: true,
    },
  ],
};
