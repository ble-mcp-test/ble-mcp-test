module.exports = {
  apps: [{
    name: 'ble-mcp-test',
    script: './dist/start-server.js',
    args: '--mcp-http',
    instances: 1,
    exec_mode: 'fork',  // Use fork mode, not cluster
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    merge_logs: true,
    
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 3000,
    
    // Restart delay
    restart_delay: 4000,
    
    // Crash handling
    min_uptime: '10s',
    max_restarts: 10,
    
    // Cron restart (optional - restart daily at 3am)
    // cron_restart: '0 3 * * *',
  }]
};