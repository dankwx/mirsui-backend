const path = require('node:path')

module.exports = {
  apps: [{
    name: 'mirsui-deezer-gateway',
    cwd: path.resolve(__dirname, '..'),
    script: './node_modules/.bin/tsx',
    args: 'src/scripts/deezerGateway.ts',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 1000,
    max_memory_restart: '256M',
    env: { NODE_ENV: 'production' },
  }],
}
