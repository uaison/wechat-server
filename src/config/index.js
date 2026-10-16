/**
 * 统一配置入口
 *
 * 设计思路:配置只在这里读取一次,其余模块一律 import 它,
 * 避免 dotenv 在各处被重复加载、也便于集中做缺省值校验。
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 读取整型环境变量,带默认值 */
function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** 启动时校验必填项 —— 早失败优于运行时才崩 */
function requireEnv(key) {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `缺少必需的环境变量 ${key}。请复制 .env.example 为 .env 并填写。`
    );
  }
  return val;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: envInt('PORT', 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  logLevel: process.env.LOG_LEVEL || 'info',

  rootDir: path.resolve(__dirname, '..'),
  migrationsDir: path.resolve(__dirname, '..', 'migrations'),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: envInt('DB_PORT', 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wechat_server',
    poolMin: envInt('DB_POOL_MIN', 2),
    poolMax: envInt('DB_POOL_MAX', 10),
  },

  // 敏感字段加密密钥,延迟校验(见 crypto.js)
  encryptKey: process.env.ENCRYPT_KEY || '',

  wechat: {
    requestTimeout: envInt('WECHAT_REQUEST_TIMEOUT', 10000),
    // 提前刷新的安全边际:剩余有效期低于此值就刷新,避免"传输途中失效"
    tokenRefreshMarginMs: envInt('TOKEN_REFRESH_MARGIN_MS', 5 * 60 * 1000),
    apiBase: 'https://api.weixin.qq.com',
  },
};

/** 用于在真正需要时才提示缺失(例如只跑迁移时不需要加密密钥) */
export { requireEnv };
