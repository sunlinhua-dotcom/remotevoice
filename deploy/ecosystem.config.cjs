// PM2 进程配置（systemd 的替代方案，更轻量）
// 用法：
//   npm run build                                   # 先编译出 dist/
//   pm2 start deploy/ecosystem.config.cjs           # 启动
//   pm2 save && pm2 startup                         # 开机自启
module.exports = {
  apps: [
    {
      name: "remotevoice-relay",
      // 构建产物在 relay/dist/server.js（npm run build 在 relay/ 下执行），
      // 故 cwd 指向 relay/，script 相对它解析；日志也落在 relay/logs/。
      script: "dist/server.js",
      cwd: __dirname + "/../relay",
      env: {
        NODE_ENV: "production",
      },
      // .env 由 server 启动时通过 dotenv 读取；也可在此用 env: 覆盖
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      // 日志
      out_file: "./logs/relay.out.log",
      error_file: "./logs/relay.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
