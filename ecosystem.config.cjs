module.exports = {
  apps: [
    {
      name: "kpp-dashboard",
      cwd: "/home/you/projects/kpp-dashboard",
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3008 -H 127.0.0.1",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
    },
  ],
};
