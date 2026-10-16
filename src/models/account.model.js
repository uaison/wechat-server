/**
 * 微信账号配置访问层
 *
 * 职责:读写 wechat_accounts 表,并对敏感字段做透明加解密。
 * 上层拿到的永远是明文,不需要关心加密细节 —— 封装以调用者为中心。
 */
import { knex } from '../db/knex.js';
import { encrypt, decrypt } from '../utils/crypto.js';

const TABLE = 'wechat_accounts';

/**
 * 把数据库行转成对外的账号对象(解密敏感字段)
 * @param {object} row 数据库原始行
 * @returns {object|null}
 */
function mapRow(row) {
  if (!row) return null;
  return {
    appid: row.appid,
    type: row.type,
    name: row.name,
    appSecret: safeDecrypt(row.app_secret),
    token: safeDecrypt(row.token),
    aesKey: safeDecrypt(row.aes_key),
    enabled: Boolean(row.enabled),
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 解密容错:字段为空或解密失败时返回 null,不让单个坏数据拖垮整体 */
function safeDecrypt(encrypted) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}

/**
 * 按 appid 查询账号(含明文密钥,供内部调用)
 * @param {string} appid
 */
export async function findByAppid(appid) {
  const row = await knex(TABLE).where({ appid }).first();
  return mapRow(row);
}

/**
 * 查询所有启用的账号
 * @param {object} [opts]
 * @param {string} [opts.type] 可选按类型过滤
 */
export async function findAllEnabled(opts = {}) {
  const query = knex(TABLE).where({ enabled: true });
  if (opts.type) query.andWhere({ type: opts.type });
  const rows = await query;
  return rows.map(mapRow);
}

/**
 * 列出所有账号(含停用的,用于管理页展示)
 */
export async function findAll() {
  const rows = await knex(TABLE).orderBy('created_at', 'desc');
  return rows.map(mapRow);
}

/**
 * 新增或更新账号(按 appid upsert)
 * @param {object} payload
 * @param {string} payload.appid
 * @param {string} payload.appSecret 明文
 * @param {string} [payload.type]
 * @param {string} [payload.name]
 * @param {string} [payload.token] 明文
 * @param {string} [payload.aesKey] 明文
 * @param {boolean} [payload.enabled]
 * @param {string} [payload.remark]
 */
export async function upsert(payload) {
  const {
    appid,
    appSecret,
    type = 'official',
    name = null,
    token = null,
    aesKey = null,
    enabled = true,
    remark = null,
  } = payload;

  if (!appid) throw new Error('appid 不能为空');
  if (!appSecret) throw new Error('appSecret 不能为空');

  const record = {
    appid,
    type,
    name,
    app_secret: encrypt(appSecret),
    token: token ? encrypt(token) : null,
    aes_key: aesKey ? encrypt(aesKey) : null,
    enabled,
    remark,
    updated_at: knex.fn.now(),
  };

  // 用 ON DUPLICATE KEY UPDATE 实现 upsert,一条 SQL 搞定
  await knex(TABLE)
    .insert({ ...record, created_at: knex.fn.now() })
    .onConflict('appid')
    .merge(['type', 'name', 'app_secret', 'token', 'aes_key', 'enabled', 'remark', 'updated_at']);

  return findByAppid(appid);
}

/**
 * 软删除:置 enabled=0(保留配置与历史,避免误删)
 * @param {string} appid
 */
export async function disable(appid) {
  return knex(TABLE).where({ appid }).update({ enabled: false, updated_at: knex.fn.now() });
}
