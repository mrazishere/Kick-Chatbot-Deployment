module.exports = {
  apps: [
    {
      name: 'Kick-Bot-Enrollment',
      script: '/home/user/Kick-Chatbot-Deployment/mr-ai-bot-enrollment.js',
      cwd: '/home/user/Kick-Chatbot-Deployment',
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
      out_file: '/home/user/Kick-Chatbot-Deployment/logs/Kick-Bot-Enrollment-out.log',
      error_file: '/home/user/Kick-Chatbot-Deployment/logs/Kick-Bot-Enrollment-err.log'
    }
  ]
};
