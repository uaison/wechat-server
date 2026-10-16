/**
 * 定时任务
 *
 * 单机场景用 node-cron 足够,不需要外部调度器。
 * 任务职责:巡检所有启用账号的 token,临期或失效则自动刷新。
 */
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import * as tokenService from '../services/token.service.js';

/**
 * 启动定时任务
 */
export function startScheduler() {
  // 每 10 分钟巡检一次 token
  // 为什么是 10 分钟? token 有效期 7200 秒,安全边际 5 分钟,
  // 10 分钟粒度足以在过期前发现并刷新,又不会给微信接口造成压力。
  const task = cron.schedule('*/10 * * * *', async () => {
    logger.debug('开始执行 token 巡检');
    try {
      const result = await tokenService.warmupAll();
      if (result.failed.length > 0) {
        logger.warn({ failed: result.failed }, 'token 巡检存在失败项');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'token 巡检任务异常');
    }
  });

  logger.info('定时任务已启动:每 10 分钟巡检 token');
  return task;
}
