const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const pm2Port = Number(process.env.PM2_PORT || process.env.PORT || 3001);
const pm2Instances = Number(
  process.env.PM2_INSTANCES || Math.max(1, Math.min(4, os.cpus().length - 1))
);
const pm2ExecMode = String(process.env.PM2_EXEC_MODE || "cluster").toLowerCase() === "fork"
  ? "fork"
  : "cluster";

const pgUser = encodeURIComponent(process.env.POSTGRES_USER || "postgres");
const pgPassword = encodeURIComponent(process.env.POSTGRES_PASSWORD || "");
const pgHost = process.env.PM2_POSTGRES_HOST || "localhost";
const pgPort = process.env.POSTGRES_PORT || "5432";
const pgDb = process.env.POSTGRES_DB || "postgres";
const pm2DatabaseUrl =
  process.env.DATABASE_URL_PM2 ||
  `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDb}`;

module.exports = {
  apps: [
    {
      name: "ei-backend",
      script: "./app.js",
      cwd: __dirname,
      instances: pm2ExecMode === "fork" ? 1 : pm2Instances,
      exec_mode: pm2ExecMode,
      autorestart: true,
      watch: false,
      max_memory_restart: "700M",
      restart_delay: 2000,
      min_uptime: "10s",
      max_restarts: 10,
      exp_backoff_restart_delay: 200,
      merge_logs: true,
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "development",
        PORT: pm2Port,
        DATABASE_URL: pm2DatabaseUrl,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: pm2Port,
        DATABASE_URL: pm2DatabaseUrl,
      },
      node_args: "--max-old-space-size=1024",
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
