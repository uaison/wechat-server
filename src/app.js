/**
 * 应用入口
 *
 * 启动顺序(顺序很重要):
 *   1. 加载配置(缺失必填项会在此刻尽早失败)
 *   2. 建立数据库连接并验证可用
 *   3. 装配 Koa 中间件与路由
 *   4. 监听端口
 *   5. 启动定时任务 + 预热 token(异步,不阻塞启动)
 *   6. 注册优雅退出
 */
import Koa from 'koa';
import { config, requireEnv } from './config/index.js';
import { logger } from './utils/logger.js';
import { knex } from './db/knex.js';
import { rawBody } from './middleware/raw-body.js';
import { errorHandler } from './middleware/error.js';
import { callbackRouter } from './routes/callback.js';
import { apiRouter } from './routes/api.js';
import { clientsRouter } from './routes/clients.js';
import { startScheduler } from './scheduler/index.js';
import * as tokenService from './services/token.service.js';

const app = new Koa();

// 信任代理头,便于拿到真实客户端 IP(部署在 Nginx 之后时)
app.proxy = true;

// ---------- 中间件装配(顺序不可随意调整)----------
// 1. 错误处理放最外层,确保能兜住后面所有中间件的异常
app.use(errorHandler());
// 2. 原始体捕获必须在最前(路由之前),供验签使用
app.use(rawBody());
// 3. 访问日志
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  // 回调接口日志级别降低,避免刷屏
  const isCallback = ctx.path.startsWith('/wechat/callback');
  const logFn = isCallback ? logger.debug.bind(logger) : logger.info.bind(logger);
  logFn({ method: ctx.method, path: ctx.path, status: ctx.status, ms }, 'request');
});

// 路由
app.use(callbackRouter.routes()).use(callbackRouter.allowedMethods());
app.use(apiRouter.routes()).use(apiRouter.allowedMethods());
app.use(clientsRouter.routes()).use(clientsRouter.allowedMethods());

// 兜底 404
app.use((ctx) => {
  ctx.status = 404;
  ctx.body = { code: 404, message: 'Not Found' };
});

/**
 * 启动服务
 */
async function bootstrap() {
  // 校验必需配置(加密密钥是硬依赖,缺失则无法读写敏感字段)
  requireEnv('ENCRYPT_KEY');
  config.encryptKey = process.env.ENCRYPT_KEY;

  // 验证数据库连通
  try {
    await knex.raw('SELECT 1');
    logger.info(
      { host: config.db.host, database: config.db.database },
      '数据库连接成功'
    );
  } catch (err) {
    logger.error({ err: err.message }, '数据库连接失败,请检查 .env 中的 DB_* 配置');
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env, baseUrl: config.baseUrl },
      `服务已启动: ${config.baseUrl}`
    );
    logger.info(`回调地址格式: ${config.baseUrl}/wechat/callback/{appid}`);
  });

  // 定时任务
  const cronTask = startScheduler();

  // 异步预热 token,不阻塞启动流程
  tokenService
    .warmupAll()
    .then((result) => {
      logger.info(
        { ok: result.ok.length, failed: result.failed.length },
        'access_token 预热完成'
      );
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'token 预热异常');
    });

  // ---------- 优雅退出 ----------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号,开始优雅关闭');

    cronTask.stop();
    server.close(async () => {
      try {
        await knex.destroy();
        logger.info('数据库连接已释放,进程退出');
        process.exit(0);
      } catch (err) {
        logger.error({ err: err.message }, '关闭过程中出错');
        process.exit(1);
      }
    });

    // 兜底:10 秒内未关闭则强制退出
    setTimeout(() => {
      logger.warn('优雅关闭超时,强制退出');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 未捕获异常:记录后退出,交给 pm2 拉起
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, '未捕获异常');
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, '未处理的 Promise 拒绝');
  });

  return server;
}

bootstrap().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, '服务启动失败');
  process.exit(1);
});

export { app };
