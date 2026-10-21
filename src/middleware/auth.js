/**
 * API 鉴权中间件
 *
 * 两级结构:
 *   1. apiAuth     —— 业务密钥(wsk_...),保护 /api/* 业务接口
 *   2. adminAuth   —— 管理员密钥(ADMIN_KEY 环境变量),保护 /api/clients 管理接口
 *
 * apiAuth 附带的授权校验:
 *   - 路由参数里的 appid(ctx.params.appid)
 *   - 请求体里的 appid(JSON body)
 *   两者只要出现,就必须在该密钥的 allowedAppids 内(或为通配 "*")
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import * as clientModel from '../models/api-client.model.js';

/** 从请求中提取 API 密钥 */
function extractKey(ctx) {
  const auth = ctx.get('authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const apiKey = ctx.get('x-api-key');
  if (apiKey) return apiKey.trim();
  return null;
}

/** 定长安全比较,防时序攻击 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * 业务密钥鉴权
 *
 * 用法(@koa/router 中,注册在需要保护的路由之前):
 *   router.use('/some-path', apiAuth())
 *
 * 成功后 ctx.state.client = { name, allowedAppids, ... }
 */
export function apiAuth() {
  return async (ctx, next) => {
    const key = extractKey(ctx);
    if (!key) {
      ctx.status = 401;
      ctx.body = { code: 401, message: '缺少 API 密钥,请在 Authorization: Bearer 或 X-API-Key 头中提供' };
      return;
    }

    // 明文密钥不应出现在 URL/日志里,这里不记录其内容
    const client = await clientModel.findEnabledByKey(key);
    if (!client) {
      logger.warn({ ip: ctx.ip, path: ctx.path }, 'API 鉴权失败:无效或已停用的密钥');
      ctx.status = 401;
      ctx.body = { code: 401, message: '无效的 API 密钥' };
      return;
    }

    ctx.state.client = client;

    // ---- appid 授权校验 ----
    const targetAppids = collectTargetAppids(ctx);
    for (const appid of targetAppids) {
      if (!clientModel.canAccessAppid(client, appid)) {
        logger.warn(
          { client: client.name, appid, path: ctx.path },
          'API 鉴权失败:密钥无权访问该 appid'
        );
        ctx.status = 403;
        ctx.body = {
          code: 403,
          message: `密钥 ${client.name} 无权访问 appid: ${appid}`,
        };
        return;
      }
    }

    await next();
  };
}

/**
 * 收集本次请求要操作的 appid
 *
 * ⚠️ 注意:经实测,@koa/router 的 use() 中间件执行时 ctx.params 还是空的
 * (参数要到路由处理器阶段才赋值),所以路径里的 appid 必须从 ctx.path 提取。
 *
 * 覆盖的路径形态:
 *   /api/token/:appid/status | /refresh
 *   /api/user/:appid/:openid
 *   /api/accounts/:appid/disable
 * 以及所有 POST/PUT/PATCH JSON 请求体里的 appid 字段。
 *
 * ⚠️ 必须排除的不是 appid 的路径段:
 *   /api/token/warmup —— 这里的 "warmup" 是动作名而非 appid,
 *   若误提取会导致只授权了具体 appid 的密钥调预热被 403 拒绝。
 */
const APPID_PATH_PATTERNS = [
  /^\/api\/token\/([^/\s]+)/,
  /^\/api\/user\/([^/\s]+)/,
  /^\/api\/accounts\/([^/\s]+)/,
];

/** 路径中形如 appid 但实际是动作名的段,不能当作 appid 校验 */
const NON_APPID_SEGMENTS = new Set(['warmup']);

function collectTargetAppids(ctx) {
  const targets = [];

  // ① 路由参数(若 router 已赋值,如未来挂在路由级中间件上)
  if (ctx.params?.appid) targets.push(ctx.params.appid);

  // ② 直接从路径提取(覆盖 use() 中间件阶段 params 为空的情况)
  for (const pattern of APPID_PATH_PATTERNS) {
    const match = ctx.path.match(pattern);
    if (match) {
      const segment = decodeURIComponent(match[1]);
      if (!NON_APPID_SEGMENTS.has(segment)) targets.push(segment);
    }
  }

  // ③ 请求体里的 appid(raw-body 中间件已把原文存到 ctx.request.rawBody)
  const raw = ctx.request.rawBody;
  if (raw && (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH')) {
    try {
      const body = JSON.parse(raw);
      if (body && typeof body.appid === 'string') targets.push(body.appid);
    } catch {
      // 非 JSON 体,忽略
    }
  }
  return targets;
}

/**
 * 管理员鉴权(保护 /api/clients)
 *
 * ADMIN_KEY 来自环境变量,与业务密钥相互独立:
 *   - 业务密钥由管理员签发给各项目
 *   - 管理员密钥绝不发给任何项目
 *
 * 未配置 ADMIN_KEY 时管理接口直接拒绝,避免"裸奔"上线。
 */
export function adminAuth() {
  return async (ctx, next) => {
    const adminKey = config.adminKey;
    if (!adminKey) {
      logger.error({ path: ctx.path }, '管理接口被拒绝:未配置 ADMIN_KEY');
      ctx.status = 503;
      ctx.body = {
        code: 503,
        message: '密钥管理接口未启用:请先在 .env 中配置 ADMIN_KEY',
      };
      return;
    }

    const provided = ctx.get('x-admin-key');
    if (!safeEqual(provided, adminKey)) {
      logger.warn({ ip: ctx.ip, path: ctx.path }, '管理接口鉴权失败');
      ctx.status = 401;
      ctx.body = { code: 401, message: '无效的管理员密钥' };
      return;
    }

    ctx.state.admin = true;
    await next();
  };
}
