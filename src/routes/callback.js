/**
 * 微信服务器消息推送回调
 *
 * 路由:/wechat/callback/:appid
 *   - 通过 URL 中的 appid 识别是哪一个号,再取对应密钥验签
 *   - 支持明文模式与安全(加密)模式
 *
 * ★ 5 秒约束:微信要求 5 秒内响应,超时会重试 -> 用户收到重复消息。
 *    所以这里:验签解密 -> 分发 -> 立即返回。处理器内部不得做重活。
 */
import Router from '@koa/router';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import * as accountModel from '../models/account.model.js';
import * as messageService from '../services/message.service.js';
import {
  checkSignature,
  makeSignature,
  decryptMessage,
  encryptMessage,
} from '../utils/wx-crypto.js';

export const callbackRouter = new Router({ prefix: '/wechat' });

/**
 * GET:微信服务器配置 URL 时的校验握手
 * 微信会带上 signature/timestamp/nonce/echostr,验签通过则原样返回 echostr
 */
callbackRouter.get('/callback/:appid', async (ctx) => {
  const { appid } = ctx.params;
  const { signature, timestamp, nonce, echostr } = ctx.query;

  const account = await accountModel.findByAppid(appid);
  if (!account) {
    logger.warn({ appid }, '回调校验:账号未配置');
    ctx.status = 404;
    ctx.body = 'account not found';
    return;
  }
  if (!account.token) {
    logger.warn({ appid }, '回调校验:账号未配置 Token,无法验签');
    ctx.status = 400;
    ctx.body = 'token not configured';
    return;
  }

  const valid = checkSignature(account.token, timestamp, nonce, signature);
  if (!valid) {
    logger.warn({ appid }, '回调校验:签名不通过');
    ctx.status = 401;
    ctx.body = 'invalid signature';
    return;
  }

  logger.info({ appid }, '回调 URL 校验通过');
  ctx.type = 'text/plain';
  ctx.body = echostr;
});

/**
 * POST:接收消息推送
 */
callbackRouter.post('/callback/:appid', async (ctx) => {
  const { appid } = ctx.params;
  const { signature, timestamp, nonce, msg_signature: msgSignature, encrypt_type: encryptType } = ctx.query;

  const account = await accountModel.findByAppid(appid);
  if (!account) {
    logger.warn({ appid }, '消息推送:账号未配置');
    ctx.status = 200;
    ctx.type = 'text/plain';
    ctx.body = 'success';
    return;
  }

  const rawBody = ctx.request.rawBody || '';
  const isEncrypted = encryptType === 'aes' || Boolean(msgSignature);

  let xml = rawBody;

  if (isEncrypted) {
    // ---- 安全模式:先验签再解密 ----
    if (!account.aesKey) {
      logger.error({ appid }, '安全模式消息但未配置 EncodingAESKey');
      ctx.body = 'success';
      return;
    }

    // 签名用的是密文,需先从 XML 中取出 Encrypt 节点
    const encryptField = extractEncrypt(rawBody);
    if (!encryptField) {
      logger.warn({ appid }, '安全模式消息缺少 Encrypt 字段');
      ctx.body = 'success';
      return;
    }

    const sigValid = checkSignature(account.token, timestamp, nonce, msgSignature, encryptField);
    if (!sigValid) {
      logger.warn({ appid }, '消息推送:消息签名不通过');
      ctx.status = 401;
      ctx.body = 'invalid signature';
      return;
    }

    try {
      const decrypted = decryptMessage(encryptField, account.aesKey, appid);
      xml = decrypted.message;
    } catch (err) {
      logger.error({ appid, err: err.message }, '消息解密失败');
      ctx.body = 'success';
      return;
    }
  } else {
    // ---- 明文模式:直接验签 ----
    const sigValid = checkSignature(account.token, timestamp, nonce, signature);
    if (!sigValid) {
      logger.warn({ appid }, '消息推送:签名不通过');
      ctx.status = 401;
      ctx.body = 'invalid signature';
      return;
    }
  }

  // ---- 解析并分发 ----
  let reply = messageService.EMPTY_REPLY;
  try {
    const parsed = await messageService.parseMessage(xml);
    const normalized = messageService.normalizeMessage(parsed);
    reply = await messageService.dispatch(normalized, { appid, account });
  } catch (err) {
    logger.error({ appid, err: err.message }, '消息解析/分发失败');
  }

  // ---- 安全模式下回复内容也需加密 ----
  if (isEncrypted && reply && reply !== messageService.EMPTY_REPLY) {
    try {
      reply = buildEncryptedReply(reply, account, nonce, timestamp);
    } catch (err) {
      logger.error({ appid, err: err.message }, '回复消息加密失败,降级为明文');
    }
  }

  ctx.type = 'text/plain';
  ctx.body = reply;
});

/**
 * 从原始 XML 中提取 Encrypt 节点内容(不做完整解析,避免格式影响)
 */
function extractEncrypt(xml) {
  const match = xml.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/);
  return match ? match[1] : null;
}

/**
 * 加密回复消息,按微信规范包装为 XML
 * 注意:回复报文需要重新用 token + timestamp + nonce + 密文 计算 MsgSignature
 */
function buildEncryptedReply(plainReply, account, nonce, timestamp) {
  const encrypted = encryptMessage(plainReply, account.aesKey, account.appid);
  const signature = makeSignature(account.token, timestamp, nonce, encrypted);

  return `<xml>
  <Encrypt><![CDATA[${encrypted}]]></Encrypt>
  <MsgSignature><![CDATA[${signature}]]></MsgSignature>
  <TimeStamp>${timestamp}</TimeStamp>
  <Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
}
