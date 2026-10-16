/**
 * access_token 数据访问层
 *
 * 表结构以 appid 为主键 —— 天然实现"按号隔离"。
 * token 本身也加密存储:即便数据库被拖走,也无法直接冒用。
 */
import { knex } from '../db/knex.js';
import { encrypt, decrypt } from '../utils/crypto.js';

const TABLE = 'access_tokens';

/**
 * 读取指定 appid 的 token 记录
 * @param {string} appid
 * @returns {Promise<{token:string, expiresAt:string, refreshedAt:string}|null>}
 */
export async function get(appid) {
  const row = await knex(TABLE).where({ appid }).first();
  if (!row) return null;
  try {
    return {
      token: decrypt(row.token),
      expiresAt: row.expires_at,
      refreshedAt: row.refreshed_at,
    };
  } catch {
    // 解密失败(如密钥被换过)视为无记录,触发重新获取
    return null;
  }
}

/**
 * 写入/更新 token
 * @param {object} payload
 * @param {string} payload.appid
 * @param {string} payload.token 明文
 * @param {Date} payload.expiresAt 绝对过期时间
 */
export async function save({ appid, token, expiresAt }) {
  const now = knex.fn.now();
  await knex(TABLE)
    .insert({
      appid,
      token: encrypt(token),
      expires_at: expiresAt,
      refreshed_at: now,
      updated_at: now,
    })
    .onConflict('appid')
    .merge(['token', 'expires_at', 'refreshed_at', 'updated_at']);
}

/**
 * 删除 token 记录(用于强制下次重新获取)
 * @param {string} appid
 */
export async function remove(appid) {
  return knex(TABLE).where({ appid }).del();
}
