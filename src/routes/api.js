/**
 * 对外业务 API
 *
 * 这些接口供你自己的前端/其他后端调用,不是给微信服务器用的。
 * 前缀 /api,统一 JSON 响应。
 */
import Router from '@koa/router';
import * as accountModel from '../models/account.model.js';
import * as tokenService from '../services/token.service.js';
import * as wechatService from '../services/wechat.service.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { apiAuth } from '../middleware/auth.js';

export const apiRouter = new Router({ prefix: '/api' });

// ============================================================
// 健康检查(公开,无需鉴权 —— 供监控探活)
// ============================================================

apiRouter.get('/health', async (ctx) => {
  ctx.body = {
    status: 'ok',
    env: config.env,
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  };
});

// ============================================================
// ★ 鉴权边界:以下所有接口都需要 API 密钥 ★
// 注意:@koa/router 的 use 只作用于其后注册的路由,
// 所以必须写在 health 之后、业务路由之前。
// ============================================================
apiRouter.use(apiAuth());

/** 解析 JSON 请求体的简易中间件(只处理 application/json) */
async function parseJsonBody(ctx) {
  if (ctx.request.rawBody) {
    try {
      return JSON.parse(ctx.request.rawBody);
    } catch {
      return {};
    }
  }
  return {};
}

// ============================================================
// 账号管理
// ============================================================

/** 列出所有账号(敏感字段已脱敏) */
apiRouter.get('/accounts', async (ctx) => {
  const accounts = await accountModel.findAll();
  ctx.body = {
    code: 0,
    data: accounts.map((a) => ({
      appid: a.appid,
      type: a.type,
      name: a.name,
      enabled: a.enabled,
      remark: a.remark,
      hasToken: Boolean(a.token),
      hasAesKey: Boolean(a.aesKey),
      createdAt: a.createdAt,
    })),
  };
});

/** 新增/更新账号 */
apiRouter.post('/accounts', async (ctx) => {
  const body = await parseJsonBody(ctx);
  if (!body.appid || !body.appSecret) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'appid 与 appSecret 为必填' };
    return;
  }
  const account = await accountModel.upsert(body);
  logger.info({ appid: body.appid }, '账号配置已保存');
  ctx.body = { code: 0, message: '保存成功', data: { appid: account.appid } };
});

/** 停用账号 */
apiRouter.post('/accounts/:appid/disable', async (ctx) => {
  const { appid } = ctx.params;
  await accountModel.disable(appid);
  ctx.body = { code: 0, message: '已停用' };
});

// ============================================================
// access_token 管理
// ============================================================

/** 查看 token 状态(不返回 token 明文) */
apiRouter.get('/token/:appid/status', async (ctx) => {
  const { appid } = ctx.params;
  const { knex } = await import('../db/knex.js');
  const row = await knex('access_tokens').where({ appid }).first();

  if (!row) {
    ctx.body = { code: 0, data: { appid, cached: false } };
    return;
  }

  const expiresAt = new Date(row.expires_at).getTime();
  ctx.body = {
    code: 0,
    data: {
      appid,
      cached: true,
      expiresAt: row.expires_at,
      refreshedAt: row.refreshed_at,
      remainingSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
      valid: expiresAt - Date.now() > config.wechat.tokenRefreshMarginMs,
    },
  };
});

/** 强制刷新指定账号的 token */
apiRouter.post('/token/:appid/refresh', async (ctx) => {
  const { appid } = ctx.params;
  const body = await parseJsonBody(ctx);
  const token = await tokenService.refreshAccessToken(appid, {
    force: body.force !== false,
  });
  ctx.body = {
    code: 0,
    message: '刷新成功',
    data: { appid, length: token.length },
  };
});

/** 批量预热所有账号 */
apiRouter.post('/token/warmup', async (ctx) => {
  const result = await tokenService.warmupAll();
  ctx.body = { code: 0, data: result };
});

// ============================================================
// 业务调用示例
// ============================================================

/** 小程序登录:code 换 openid */
apiRouter.post('/mini/session', async (ctx) => {
  const body = await parseJsonBody(ctx);
  if (!body.appid || !body.code) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'appid 与 code 为必填' };
    return;
  }

  const account = await accountModel.findByAppid(body.appid);
  if (!account) {
    ctx.status = 404;
    ctx.body = { code: 404, message: '账号未配置' };
    return;
  }

  const data = await wechatService.code2Session(body.appid, body.code, account.appSecret);
  ctx.body = { code: 0, data };
});

/** 发送客服消息 */
apiRouter.post('/message/custom/send', async (ctx) => {
  const body = await parseJsonBody(ctx);
  if (!body.appid || !body.message) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'appid 与 message 为必填' };
    return;
  }
  const data = await wechatService.sendCustomMessage(body.appid, body.message);
  ctx.body = { code: 0, data };
});

/** 获取公众号用户信息 */
apiRouter.get('/user/:appid/:openid', async (ctx) => {
  const { appid, openid } = ctx.params;
  const data = await wechatService.getUserInfo(appid, openid);
  ctx.body = { code: 0, data };
});
