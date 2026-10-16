/**
 * 微信消息加解密与签名校验
 *
 * 严格对应微信官方的 WXBizMsgCrypt 实现规范:
 *   - 签名算法:sha1(sort(token, timestamp, nonce, encrypt))
 *   - 消息体加密:AES-256-CBC,密钥 = Base64Decode(EncodingAESKey + "=")
 *   - IV 取密钥前 16 字节
 *   - 明文结构:random(16B) + msgLen(4B, 网络字节序) + msg + appid
 *
 * ⚠️ 这里必须用「原始请求体」参与签名,不能是重新序列化后的字符串,
 *    否则 JSON/XML 格式差异会导致签名不一致。
 */
import crypto from 'node:crypto';

const PKCS7_ENCODE_BLOCK = 32;

/**
 * 生成微信签名
 * @param {string} token 账号配置里的 Token
 * @param {string} timestamp
 * @param {string} nonce
 * @param {string} [encrypt] 加密消息体(明文模式下不传)
 * @returns {string} 40 位 sha1 十六进制串
 */
export function makeSignature(token, timestamp, nonce, encrypt = '') {
  const arr = [token, timestamp, nonce];
  if (encrypt) arr.push(encrypt);
  arr.sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

/**
 * 校验签名(防时序攻击:用 timingSafeEqual 做定长比较)
 */
export function checkSignature(token, timestamp, nonce, signature, encrypt = '') {
  const expected = makeSignature(token, timestamp, nonce, encrypt);
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * 由 EncodingAESKey(43 位)推导 AES 密钥
 */
function decodeAesKey(encodingAesKey) {
  if (!encodingAesKey || encodingAesKey.length !== 43) {
    throw new Error('EncodingAESKey 长度必须为 43 位');
  }
  return Buffer.from(`${encodingAesKey}=`, 'base64');
}

/**
 * PKCS#7 填充(块大小 32)
 */
function pkcs7Pad(buf) {
  const padLen = PKCS7_ENCODE_BLOCK - (buf.length % PKCS7_ENCODE_BLOCK);
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, pad]);
}

/**
 * 去除 PKCS#7 填充并校验
 */
function pkcs7Unpad(buf) {
  if (buf.length === 0) throw new Error('解密结果为空');
  const padLen = buf[buf.length - 1];
  if (padLen < 1 || padLen > PKCS7_ENCODE_BLOCK) {
    throw new Error('非法的填充字节');
  }
  const contentLen = buf.length - padLen;
  if (contentLen < 0) throw new Error('填充长度越界');
  // 校验填充内容一致性
  for (let i = contentLen; i < buf.length; i += 1) {
    if (buf[i] !== padLen) throw new Error('填充字节不一致');
  }
  return buf.subarray(0, contentLen);
}

/**
 * 解密微信推送的密文消息
 * @param {string} encrypted Base64 密文(URL 中的 msg_signature 对应的 encrypt 参数)
 * @param {string} encodingAesKey 43 位
 * @param {string} appid 用于校验明文尾部的 appid,防串号
 * @returns {{message: string, appid: string}} 解密后的 XML 字符串
 */
export function decryptMessage(encrypted, encodingAesKey, appid) {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false); // 自己去填充,以便精确校验

  const decrypted = pkcs7Unpad(
    Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ])
  );

  // 结构:random(16) + msgLen(4,BE) + msg + appid
  const msgLen = decrypted.readUInt32BE(16);
  const message = decrypted.subarray(20, 20 + msgLen).toString('utf8');
  const fromAppid = decrypted.subarray(20 + msgLen).toString('utf8');

  if (appid && fromAppid !== appid) {
    throw new Error(`消息 appid 不匹配:期望 ${appid},实际 ${fromAppid}`);
  }

  return { message, appid: fromAppid };
}

/**
 * 加密回复消息(被动回复时使用)
 * @param {string} message 明文 XML
 * @param {string} encodingAesKey 43 位
 * @param {string} appid
 * @returns {string} Base64 密文
 */
export function encryptMessage(message, encodingAesKey, appid) {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);

  const msgBuf = Buffer.from(message, 'utf8');
  const appidBuf = Buffer.from(appid, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  const plain = pkcs7Pad(
    Buffer.concat([crypto.randomBytes(16), lenBuf, msgBuf, appidBuf])
  );

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}
