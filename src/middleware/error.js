/**
 * 统一错误处理中间件
 *
 * 分三类返回:
 *   1. 业务异常(带 status)      -> 按 status 返回结构化错误
 *   2. WechatApiError            -> 502,因上游微信出错
 *   3. 未知异常                  -> 500,logs 里保留堆栈,响应不泄露细节
 */
import { logger } from '../utils/logger.js';
import { WechatApiError } from '../utils/http.js';

export function errorHandler() {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      // 微信回调路径出错时,仍要尽量返回 success,避免微信疯狂重试
      const isCallback = ctx.path.startsWith('/wechat/callback');

      if (err instanceof WechatApiError) {
        ctx.status = 502;
        ctx.body = {
          code: err.errcode,
          message: err.errmsg,
          detail: '上游微信接口返回错误',
        };
        logger.error({ errcode: err.errcode, errmsg: err.errmsg, path: ctx.path }, '微信接口错误');
        return;
      }

      const status = err.status || err.statusCode || 500;
      ctx.status = status;
      ctx.body = {
        code: err.code || status,
        message: status === 500 ? '服务器内部错误' : err.message,
      };

      const level = status >= 500 ? 'error' : 'warn';
      logger[level](
        { path: ctx.path, method: ctx.method, status, err: err.message, stack: err.stack },
        '请求处理异常'
      );

      if (isCallback && ctx.status >= 500) {
        // 兜底:回调接口不向上抛 5xx,改为 success 由业务自行补偿
        ctx.status = 200;
        ctx.type = 'text/plain';
        ctx.body = 'success';
      }
    }
  };
}
