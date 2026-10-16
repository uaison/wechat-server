/**
 * ★ 核心:access_token 统一管理
 *
 * 设计决策(已与需求方确认):
 *  1. 使用 stable 接口 /cgi-bin/stable_token —— 新旧 token 有共存窗口,
 *     不需要担心"刷新把在用 token 踢掉"。
 *  2. 复用优先:剩余有效期 > 安全边际(默认 5 分钟)时直接复用库中 token。
 *  3. 常规刷新传 force_refresh=false,让微信自行判断,可能直接返回现有 token。
 *  4. 兜底:业务调用若收到 40001/40014/42001,强制 force_refresh=true 重试一次。
 *
 * 并发控制:同一进程内对同一 appid 的刷新用"进行中 Promise"合并,
 * 避免并发请求同时打爆 token 接口(单机场景无需分布式锁)。
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { requestJson } from '../utils/http.js';
import * as tokenModel from '../models/token.model.js';
import * as accountModel from '../models/account.model.js';

const STABLE_TOKEN_PATH = '/cgi-bin/stable_token';

/** 进行中的刷新任务:appid -> Promise,用于合并并发刷新 */
const inflight = new Map();

/**
 * 获取指定 appid 的可用 access_token
 * @param {string} appid
 * @param {object} [opts]
 * @param {boolean} [opts.force] 强制刷新(忽略本地缓存)
 * @returns {Promise<string>}
 */
export async function getAccessToken(appid, opts = {}) {
  const { force = false } = opts;

  if (!force) {
    const cached = await readValidFromCache(appid);
    if (cached) return cached;
  }

  return refreshAccessToken(appid, { force });
}

/**
 * 从库中读取仍在有效期内的 token
 * @returns {Promise<string|null>}
 */
async function readValidFromCache(appid) {
  const record = await tokenModel.get(appid);
  if (!record) return null;

  const expiresAt = new Date(record.expiresAt).getTime();
  const now = Date.now();

  // 关键:留出传输边际,剩余不足即视为不可用
  if (expiresAt - now > config.wechat.tokenRefreshMarginMs) {
    return record.token;
  }
  return null;
}

/**
 * 调用微信接口刷新 token 并落库
 * @param {string} appid
 * @param {object} [opts]
 * @param {boolean} [opts.force] force_refresh 参数
 * @returns {Promise<string>}
 */
export async function refreshAccessToken(appid, opts = {}) {
  const { force = false } = opts;

  // 并发合并:同一个 appid 已在刷新中,直接复用那个 Promise
  if (inflight.has(appid)) {
    return inflight.get(appid);
  }

  const task = doRefresh(appid, force).finally(() => inflight.delete(appid));
  inflight.set(appid, task);
  return task;
}

/** 实际执行刷新 */
async function doRefresh(appid, force) {
  const account = await accountModel.findByAppid(appid);
  if (!account) {
    throw new Error(`未找到 appid 为 ${appid} 的账号配置`);
  }
  if (!account.enabled) {
    throw new Error(`账号 ${appid} 已被停用`);
  }
  if (!account.appSecret) {
    throw new Error(`账号 ${appid} 的 appSecret 解密失败或未配置`);
  }

  logger.debug({ appid, force }, '开始刷新 access_token');

  // 小程序与公众号的 stable_token 接口路径一致,仅 appid/secret 不同
  const data = await requestJson(STABLE_TOKEN_PATH, {
    params: {
      grant_type: 'client_credential',
      appid,
      secret: account.appSecret,
      force_refresh: force, // 常规 false,兜底强制刷新时 true
    },
  });

  if (!data.access_token) {
    throw new Error(`stable_token 返回缺少 access_token 字段: ${JSON.stringify(data)}`);
  }

  const expiresIn = Number.parseInt(data.expires_in, 10) || 7200;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await tokenModel.save({ appid, token: data.access_token, expiresAt });

  logger.info(
    { appid, expiresIn, expiresAt: expiresAt.toISOString(), force },
    'access_token 已刷新'
  );

  return data.access_token;
}

/**
 * 带自动重试的调用包装器 ★业务方应通过它调用微信接口★
 *
 * 流程:取 token -> 执行 -> 若凭据类错误则强制刷新 -> 重试一次
 *
 * @param {string} appid
 * @param {(token: string) => Promise<any>} fn 业务函数,接收 token
 * @returns {Promise<any>}
 */
export async function withToken(appid, fn) {
  const { isCredentialError } = await import('../utils/http.js');

  const token = await getAccessToken(appid);
  try {
    return await fn(token);
  } catch (err) {
    if (!isCredentialError(err)) throw err;

    // 时间未到但已被微信作废的兜底:强制换新,只重试一次防死循环
    logger.warn({ appid, errcode: err.errcode }, '凭据类错误,强制刷新 token 后重试');
    const fresh = await refreshAccessToken(appid, { force: true });
    return fn(fresh);
  }
}

/**
 * 批量确保所有启用账号都有可用 token
 * 用于服务启动时预热、以及定时任务巡检。
 * 单个账号失败不影响其他账号。
 * @returns {Promise<{ok: string[], failed: Array<{appid:string,error:string}>}>}
 */
export async function warmupAll() {
  const accounts = await accountModel.findAllEnabled();
  const ok = [];
  const failed = [];

  for (const account of accounts) {
    try {
      await getAccessToken(account.appid);
      ok.push(account.appid);
    } catch (err) {
      failed.push({ appid: account.appid, error: err.message });
      logger.error({ appid: account.appid, err: err.message }, 'token 预热失败');
    }
  }

  // 提示即将过期的账号(便于发现异常)
  const expiring = await listExpiringSoon();
  if (expiring.length > 0) {
    logger.warn({ expiring }, '以下账号 token 即将过期或已过期');
  }

  return { ok, failed };
}

/**
 * 列出临期/已过期的账号(观测与运维用)
 */
export async function listExpiringSoon() {
  const { knex } = await import('../db/knex.js');
  const threshold = new Date(Date.now() + config.wechat.tokenRefreshMarginMs);
  const rows = await knex('access_tokens')
    .where('expires_at', '<', threshold)
    .select('appid', 'expires_at');
  return rows;
}
