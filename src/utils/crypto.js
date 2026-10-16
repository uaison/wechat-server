/**
 * 敏感字段加解密
 *
 * 算法:AES-256-GCM
 * 为什么选 GCM 而不是 CBC?
 *   GCM 自带完整性校验(authTag),密文被篡改会解密失败,
 *   而 CBC 不校验完整性,攻击者可构造畸形数据。
 *
 * 密钥来源:环境变量 ENCRYPT_KEY(64 位 hex = 32 字节)
 * ★ 密钥绝不入库,数据库只存密文 —— 库被拖走也解不开。
 *
 * 密文格式:`v1:<iv_hex>:<tag_hex>:<data_hex>`
 *   带版本前缀,方便日后换算法时平滑迁移。
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;       // GCM 推荐 96 bit
const TAG_LEN = 16;      // 认证标签长度
const VERSION = 'v1';

let cachedKey = null;

/**
 * 惰性读取并校验密钥
 * 放在函数内而非模块顶层:这样只跑 migrate 时不配 ENCRYPT_KEY 也不报错。
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = config.encryptKey;
  if (!raw) {
    throw new Error(
      '未配置 ENCRYPT_KEY。请执行 `npm run keygen` 生成并写入 .env。'
    );
  }
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPT_KEY 长度不正确:期望 64 位十六进制(32 字节),实际 ${buf.length} 字节。`
    );
  }
  cachedKey = buf;
  return cachedKey;
}

/**
 * 加密明文
 * @param {string} plain 明文
 * @returns {string} 形如 v1:iv:tag:data 的密文
 */
export function encrypt(plain) {
  if (plain === null || plain === undefined) return null;
  const text = String(plain);
  if (text === '') return null;

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('hex'),
    tag.toString('hex'),
    data.toString('hex'),
  ].join(':');
}

/**
 * 解密密文
 * @param {string} encrypted 形如 v1:iv:tag:data
 * @returns {string|null} 明文
 */
export function decrypt(encrypted) {
  if (!encrypted) return null;

  const parts = String(encrypted).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('密文格式不正确或版本不支持');
  }

  const [, ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/**
 * 检测字符串是否为本模块生成的密文
 */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}
