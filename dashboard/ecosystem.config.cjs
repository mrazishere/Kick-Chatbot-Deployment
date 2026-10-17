module.exports = {
  apps: [
    {
      name: "kpp-dashboard",
      cwd: "/home/you/projects/kpp-dashboard",
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3008 -H 127.0.0.1",
      instances: 1,
      // Cluster mode so `pm2 reload` (scripts/deploy.sh) starts the new server and
      // waits for it to listen before stopping the old one: no gap between builds.
      exec_mode: "cluster",
      listen_timeout: 30000,
      kill_timeout: 5000,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      // Cluster mode would otherwise add the instance id to each log file name.
      merge_logs: true,
      time: true,
    },
  ],
};
