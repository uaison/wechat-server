/**
 * 密钥(调用方)管理接口
 *
 * 全部受 adminAuth 保护(X-Admin-Key 头)。
 * 这里是"发钥匙的地方",业务项目只拿到 wsk_ 明文密钥,永远接触不到本组接口。
 *
 * 引导流程:
 *   1. 运维在 .env 配置 ADMIN_KEY
 *   2. 管理员调 POST /api/clients 为项目 A 签发密钥(明文仅返回一次)
 *   3. 项目 A 的后端拿密钥调业务接口
 */
import Router from '@koa/router';
import * as clientModel from '../models/api-client.model.js';
import { adminAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

export const clientsRouter = new Router({ prefix: '/api/clients' });

/** 解析 JSON 请求体 */
function parseBody(ctx) {
  if (!ctx.request.rawBody) return {};
  try {
    return JSON.parse(ctx.request.rawBody);
  } catch {
    return {};
  }
}

/**
 * 兼容 snake_case 与 camelCase 两种字段名
 *
 * 坑:微信生态全是下划线(appid / app_secret / aes_key),调用方按直觉写成
 * allowed_appids 很自然;但本接口对外字段是 allowedAppids。两边都收,省得踩。
 */
function pickAppids(body) {
  if (body.allowedAppids !== undefined) return body.allowedAppids;
  if (body.allowed_appids !== undefined) return body.allowed_appids;
  return undefined;
}


clientsRouter.use(adminAuth());

/**
 * GET /api/clients —— 列出全部调用方
 */
clientsRouter.get('/', async (ctx) => {
  const clients = await clientModel.findAll();
  ctx.body = { code: 0, data: clients };
});

/**
 * POST /api/clients —— 签发新密钥
 *
 * 请求体: { name, allowedAppids: ["wxAAA1", ...] 或 ["*"], remark? }
 * 响应含明文密钥 key —— 仅此一次,丢失只能 rotate 重发。
 */
clientsRouter.post('/', async (ctx) => {
  const body = parseBody(ctx);
  if (!body.name) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'name 为必填' };
    return;
  }

  try {
    const { client, key } = await clientModel.create({
      name: body.name,
      allowedAppids: pickAppids(body) || [],
      remark: body.remark || null,
    });
    logger.info({ client: client.name, appids: client.allowedAppids }, '已签发 API 密钥');
    ctx.body = {
      code: 0,
      message: '创建成功。请立即保存密钥,它不会再次显示',
      data: { client, key },
    };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || /UNIQUE/i.test(err.message)) {
      ctx.status = 409;
      ctx.body = { code: 409, message: `项目名 ${body.name} 已存在` };
      return;
    }
    throw err;
  }
});

/**
 * PATCH /api/clients/:name —— 更新授权范围或备注
 */
clientsRouter.patch('/:name', async (ctx) => {
  const { name } = ctx.params;
  const body = parseBody(ctx);

  const allowedAppids = pickAppids(body);

  // 一个字段都没给 → 报错,而不是静默返回 200 让人误以为改成功
  if (allowedAppids === undefined && body.remark === undefined) {
    ctx.status = 400;
    ctx.body = {
      code: 400,
      message: '没有可更新的字段。请传 allowedAppids(或 allowed_appids)与 remark 中的至少一个',
    };
    return;
  }
  if (allowedAppids !== undefined && !Array.isArray(allowedAppids)) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'allowedAppids 必须是数组,例如 ["*"] 或 ["wx123"]' };
    return;
  }

  const client = await clientModel.update(name, {
    allowedAppids,
    remark: body.remark,
  });
  if (!client) {
    ctx.status = 404;
    ctx.body = { code: 404, message: `项目 ${name} 不存在` };
    return;
  }
  logger.info({ client: name, appids: client.allowedAppids }, 'API 密钥授权已更新');
  ctx.body = { code: 0, data: client };
});

/**
 * POST /api/clients/:name/enable | /disable —— 启用/吊销
 */
async function toggle(ctx, enabled) {
  const { name } = ctx.params;
  const client = await clientModel.setEnabled(name, enabled);
  if (!client) {
    ctx.status = 404;
    ctx.body = { code: 404, message: `项目 ${name} 不存在` };
    return;
  }
  logger.info({ client: name, enabled }, 'API 密钥状态已变更');
  ctx.body = { code: 0, message: enabled ? '已启用' : '已吊销', data: client };
}

clientsRouter.post('/:name/disable', (ctx) => toggle(ctx, false));
clientsRouter.post('/:name/enable', (ctx) => toggle(ctx, true));

/**
 * POST /api/clients/:name/rotate —— 轮换密钥
 *
 * 生成新明文密钥,旧密钥立即失效。用于密钥泄露后的应急处理。
 */
clientsRouter.post('/:name/rotate', async (ctx) => {
  const { name } = ctx.params;
  const result = await clientModel.rotateKey(name);
  if (!result) {
    ctx.status = 404;
    ctx.body = { code: 404, message: `项目 ${name} 不存在` };
    return;
  }
  logger.warn({ client: name }, 'API 密钥已轮换,旧密钥立即失效');
  ctx.body = {
    code: 0,
    message: '轮换成功。旧密钥已失效,请立即保存新密钥(仅显示一次)',
    data: { client: result.client, key: result.key },
  };
});
