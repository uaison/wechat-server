/**
 * 微信服务端 API 封装
 *
 * 原则:所有需要 access_token 的接口,一律通过 token.service 的 withToken 调用,
 * 业务代码不需要自己传 token、也不需要处理失效重试。
 *
 * 这里按"用途分组"暴露方法,而不是把几十个接口平铺 —— 调用者一眼能看出模块边界。
 */
import { requestJson, requestJsonPost } from '../utils/http.js';
import { withToken } from './token.service.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 小程序
// ============================================================

/**
 * code2Session:小程序登录凭证校验
 * 注意:这个接口用的是 appid/secret 直传,不需要 access_token
 * @param {string} appid
 * @param {string} jsCode wx.login 返回的 code
 * @returns {Promise<{openid:string, session_key:string, unionid?:string}>}
 */
export async function code2Session(appid, jsCode, appSecret) {
  const data = await requestJson('/sns/jscode2session', {
    params: {
      appid,
      secret: appSecret,
      js_code: jsCode,
      grant_type: 'authorization_code',
    },
  });
  return data;
}

// ============================================================
// 通用:账号信息 / 用户标签 等(示例,可按需扩展)
// ============================================================

/**
 * 获取接口调用凭据的剩余额度(调试用,可用于验证 token 有效性)
 * @param {string} appid
 */
export async function getApiQuota(appid) {
  return withToken(appid, (token) =>
    requestJsonPost('/cgi-bin/openapi/quota/get', { cgi_path: '/cgi-bin/token' }, { params: { access_token: token } })
  );
}

/**
 * 获取用户基本信息(公众号)
 * @param {string} appid
 * @param {string} openid
 */
export async function getUserInfo(appid, openid) {
  return withToken(appid, (token) =>
    requestJson('/cgi-bin/user/info', {
      params: { access_token: token, openid, lang: 'zh_CN' },
    })
  );
}

/**
 * 获取公众号已创建的标签
 * @param {string} appid
 */
export async function getTags(appid) {
  return withToken(appid, (token) =>
    requestJson('/cgi-bin/tags/get', { params: { access_token: token } })
  );
}

/**
 * 获取小程序码(示例:返回 Buffer 的场景)
 * 这里返回接口 JSON,实际业务可改造为接收二进制
 * @param {string} appid
 * @param {object} payload
 */
export async function getWxaCode(appid, payload) {
  return withToken(appid, (token) =>
    requestJsonPost('/wxa/getwxacode', payload, { params: { access_token: token } })
  );
}

// ============================================================
// 消息:客服消息(主动发消息)
// ============================================================

/**
 * 发送客服消息
 * @param {string} appid
 * @param {object} message 形如 { touser, msgtype:'text', text:{content} }
 */
export async function sendCustomMessage(appid, message) {
  return withToken(appid, async (token) => {
    const data = await requestJsonPost('/cgi-bin/message/custom/send', message, {
      params: { access_token: token },
    });
    logger.info({ appid, touser: message.touser, msgtype: message.msgtype }, '客服消息已发送');
    return data;
  });
}

/**
 * 创建菜单(公众号)
 * @param {string} appid
 * @param {object} menu
 */
export async function createMenu(appid, menu) {
  return withToken(appid, (token) =>
    requestJsonPost('/cgi-bin/menu/create', menu, { params: { access_token: token } })
  );
}
