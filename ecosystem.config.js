// Only this one app. `pm2 start ecosystem.config.js` never touches other
// processes already running on the host.
module.exports = {
  apps: [
    {
      name: 'lf-buy-bot',
      script: 'src/index.js',
      cwd: __dirname,
      restart_delay: 5000,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
