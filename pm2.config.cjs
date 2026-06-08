module.exports = {
  apps: [{
    name: 'wiki-watch',
    script: 'scripts/watch-runner.cjs',
    cwd: 'c:\\Users\\USER\\Desktop\\snu-wiki-chat',
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'development' },
  }],
};
