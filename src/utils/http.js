/**
 * 统一 HTTP 请求封装(基于 Node 内置 fetch)
 *
 * 设计目标:调用极简。
 *   const data = await requestJson('/cgi-bin/token', { params: {...} })
 * 自动完成:拼接 baseURL、超时控制、微信 errcode 判定、错误抛出。
 */
import { config } from '../config/index.js';
import { logger } from './logger.js';

/** 微信业务异常 */
export class WechatApiError extends Error {
  constructor(errcode, errmsg, url) {
    super(`微信接口错误 ${errcode}: ${errmsg}`);
    this.name = 'WechatApiError';
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.url = url;
  }
}

/** 判断是否为"凭据失效"类错误 —— 这类错误应触发 token 强制刷新后重试 */
export function isCredentialError(err) {
  return (
    err instanceof WechatApiError &&
    // 40001 凭据无效 / 40014 不合法的 token / 42001 token 超时
    [40001, 40014, 42001].includes(err.errcode)
  );
}

/**
 * 发起 GET 请求并解析 JSON
 * @param {string} path 以 / 开头的接口路径
 * @param {object} [opts]
 * @param {object} [opts.params] query 参数
 * @param {boolean} [opts.throwOnErrcode] 是否在 errcode!=0 时抛错,默认 true
 * @returns {Promise<object>}
 */
export async function requestJson(path, opts = {}) {
  const { params = {}, throwOnErrcode = true } = opts;

  const url = new URL(path, config.wechat.apiBase);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.wechat.requestTimeout
  );

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`请求微信接口超时(${config.wechat.requestTimeout}ms): ${path}`);
    }
    throw new Error(`请求微信接口失败: ${path} - ${err.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`微信接口返回 HTTP ${res.status}: ${path}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`微信接口返回非 JSON 内容: ${path}`);
  }

  if (throwOnErrcode && data.errcode && data.errcode !== 0) {
    logger.warn({ path, errcode: data.errcode, errmsg: data.errmsg }, '微信接口业务错误');
    throw new WechatApiError(data.errcode, data.errmsg, url.toString());
  }

  return data;
}

/**
 * 发起 POST JSON 请求
 * @param {string} path
 * @param {object} body
 * @param {object} [opts]
 * @param {object} [opts.params] query 参数(如 access_token)
 */
export async function requestJsonPost(path, body, opts = {}) {
  const { params = {} } = opts;

  const url = new URL(path, config.wechat.apiBase);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.wechat.requestTimeout
  );

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`请求微信接口超时(${config.wechat.requestTimeout}ms): ${path}`);
    }
    throw new Error(`请求微信接口失败: ${path} - ${err.message}`);
  }
  clearTimeout(timer);

  const data = await res.json();
  if (data.errcode && data.errcode !== 0) {
    logger.warn({ path, errcode: data.errcode, errmsg: data.errmsg }, '微信接口业务错误');
    throw new WechatApiError(data.errcode, data.errmsg, url.toString());
  }
  return data;
}
