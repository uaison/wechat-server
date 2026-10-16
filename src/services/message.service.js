/**
 * 消息处理服务
 *
 * 微信推送过来的是 XML,需要先解析再分发到具体处理器。
 * 核心约束:**微信要求 5 秒内响应**,所以这里只做"解析 + 快速分发",
 * 任何耗时业务都应丢到异步队列(见 queue.js)。
 */
import { parseStringPromise } from 'xml2js';
import { logger } from '../utils/logger.js';

/**
 * 解析微信推送的 XML
 * @param {string} xml
 * @returns {Promise<object>} 扁平化的对象
 */
export async function parseMessage(xml) {
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
  });
  return parsed.xml || {};
}

/**
 * 判断消息类型并归一化
 * @param {object} msg 解析后的 XML 对象
 */
export function normalizeMessage(msg) {
  return {
    toUserName: msg.ToUserName,
    fromUserName: msg.FromUserName,
    createTime: Number.parseInt(msg.CreateTime, 10),
    msgType: msg.MsgType,
    msgId: msg.MsgId,
    event: msg.Event,           // 事件类型(订阅/取消等)
    eventKey: msg.EventKey,
    content: msg.Content,       // 文本内容
    mediaId: msg.MediaId,
    // 保留原始对象,便于扩展字段
    raw: msg,
  };
}

/**
 * 构造文本回复的 XML
 * @param {object} opts
 * @param {string} opts.toUser 接收方(即发来消息的用户)
 * @param {string} opts.fromUser 发送方(公众号原始 ID)
 * @param {string} opts.content 文本内容
 */
export function buildTextReply({ toUser, fromUser, content }) {
  return `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`;
}

/**
 * 回复"success"表示已收到、无需被动回复
 * 微信收到 success 后不再重试推送。
 */
export const EMPTY_REPLY = 'success';

/**
 * 消息分发器
 *
 * 采用注册表模式:不同消息类型注册各自的处理器,
 * 新增类型只需 register,不必改动分发逻辑。
 */
const handlers = new Map();

/**
 * 注册消息处理器
 * @param {string} key 形如 'text' / 'event.subscribe' / '*'
 * @param {(msg: object, ctx: object) => Promise<string|null>} handler 返回回复 XML 或 null
 */
export function register(key, handler) {
  handlers.set(key, handler);
}

/**
 * 分发消息到对应处理器
 * @param {object} msg 归一化后的消息
 * @param {object} ctx 上下文(含 account、appid 等)
 * @returns {Promise<string>} 回复内容,默认 'success'
 */
export async function dispatch(msg, ctx) {
  const eventKey = msg.event ? `event.${msg.event.toLowerCase()}` : null;

  const handler =
    (eventKey && handlers.get(eventKey)) ||
    handlers.get(msg.msgType) ||
    handlers.get('*');

  if (!handler) {
    logger.debug(
      { appid: ctx.appid, msgType: msg.msgType, event: msg.event },
      '无匹配处理器,返回 success'
    );
    return EMPTY_REPLY;
  }

  try {
    const reply = await handler(msg, ctx);
    return reply || EMPTY_REPLY;
  } catch (err) {
    // 处理器异常不能影响微信的 5 秒响应,记录后返回 success
    logger.error(
      { appid: ctx.appid, msgType: msg.msgType, err: err.message, stack: err.stack },
      '消息处理器执行失败'
    );
    return EMPTY_REPLY;
  }
}

// ============================================================
// 默认处理器:按需替换为真实业务
// ============================================================

register('event.subscribe', async (msg, ctx) => {
  logger.info({ appid: ctx.appid, from: msg.fromUserName }, '用户关注');
  return buildTextReply({
    toUser: msg.fromUserName,
    fromUser: msg.toUserName,
    content: '感谢关注!',
  });
});

register('event.unsubscribe', async (msg, ctx) => {
  logger.info({ appid: ctx.appid, from: msg.fromUserName }, '用户取关');
  return null;
});

register('*', async (msg, ctx) => {
  logger.info(
    { appid: ctx.appid, msgType: msg.msgType, event: msg.event, from: msg.fromUserName },
    '收到未处理消息'
  );
  return null;
});
