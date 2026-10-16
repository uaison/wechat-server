/**
 * 日志实例
 *
 * 开发环境用 pino-pretty 输出可读格式,生产环境输出结构化 JSON。
 * 微信相关日志统一带 appid 字段,方便按号排查。
 */
import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  transport: config.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});
