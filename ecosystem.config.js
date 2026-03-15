const path = require('path');

module.exports = {
  apps: [
    {
      name: 'Kick-Bot-Enrollment',
      script: path.join(__dirname, 'dist', 'mr-ai-bot-enrollment.js'),
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      out_file: path.join(__dirname, 'logs', 'Kick-Bot-Enrollment-out.log'),
      error_file: path.join(__dirname, 'logs', 'Kick-Bot-Enrollment-err.log')
    }
  ]
};
