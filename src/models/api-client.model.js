/**
 * API 调用方(项目)密钥管理 —— 数据访问层
 *
 * 安全模型(与 GitHub PAT 相同):
 *   - 明文密钥只在创建时返回一次,数据库只存 SHA-256 哈希
 *   - 校验时对请求带来的明文重算哈希,与库中哈希比对
 *   - 数据库被拖走也无法还原任何密钥
 *
 * 授权模型:
 *   - allowed_appids 限定该项目可访问哪些微信 appid
 *   - ["*"] 通配全部(仅建议给管理工具用)
 *   - enabled=false 即吊销,下一次请求立即生效
 */
import crypto from 'node:crypto';
import { knex } from '../db/knex.js';
import { sha256 } from '../utils/crypto.js';

const TABLE = 'api_clients';
const KEY_PREFIX_TAG = 'wsk_';

/**
 * 生成新密钥并入库
 * @param {object} payload
 * @param {string} payload.name 项目名称(唯一,作为调用者身份)
 * @param {string[]} [payload.allowedAppids] 允许的 appid 列表,默认 []
 * @param {string} [payload.remark]
 * @returns {Promise<{client: object, key: string}>} key 为明文,仅在此时可见
 */
export async function create(payload) {
  const { name, allowedAppids = [], remark = null } = payload;

  if (!name || typeof name !== 'string') {
    throw new Error('name 不能为空');
  }
  if (!Array.isArray(allowedAppids)) {
    throw new Error('allowedAppids 必须是数组');
  }

  const plainKey = KEY_PREFIX_TAG + crypto.randomBytes(32).toString('hex');

  const record = {
    name: name.trim(),
    key_hash: sha256(plainKey),
    key_prefix: plainKey.slice(0, 12),
    allowed_appids: JSON.stringify(allowedAppids),
    enabled: true,
    remark,
  };

  await knex(TABLE).insert({ ...record, created_at: knex.fn.now(), updated_at: knex.fn.now() });

  const client = await findByName(record.name);
  // 明文密钥只在这里返回一次
  return { client, key: plainKey };
}

/**
 * 由密钥哈希查询启用的调用方(鉴权中间件用)
 * @param {string} plainKey 请求带来的明文密钥
 * @returns {Promise<object|null>} 含 name / allowedAppids
 */
export async function findEnabledByKey(plainKey) {
  const row = await knex(TABLE)
    .where({ key_hash: sha256(plainKey), enabled: true })
    .first();
  return mapRow(row);
}

/**
 * 按名称查询
 */
export async function findByName(name) {
  const row = await knex(TABLE).where({ name }).first();
  return mapRow(row);
}

/**
 * 列出全部调用方(管理页用,不含明文)
 */
export async function findAll() {
  const rows = await knex(TABLE).orderBy('created_at', 'desc');
  return rows.map(mapRow);
}

/**
 * 更新授权范围与备注
 * @param {string} name
 * @param {object} patch { allowedAppids?, remark? }
 */
export async function update(name, patch) {
  const updates = {};
  if (patch.allowedAppids !== undefined) {
    if (!Array.isArray(patch.allowedAppids)) {
      throw new Error('allowedAppids 必须是数组');
    }
    updates.allowed_appids = JSON.stringify(patch.allowedAppids);
  }
  if (patch.remark !== undefined) updates.remark = patch.remark;

  if (Object.keys(updates).length === 0) return findByName(name);

  updates.updated_at = knex.fn.now();
  await knex(TABLE).where({ name }).update(updates);
  return findByName(name);
}

/**
 * 启用 / 停用(停用即吊销)
 */
export async function setEnabled(name, enabled) {
  const count = await knex(TABLE)
    .where({ name })
    .update({ enabled: Boolean(enabled), updated_at: knex.fn.now() });
  if (count === 0) return null;
  return findByName(name);
}

/**
 * 轮换密钥:生成新明文,旧密钥立即失效
 * @param {string} name
 * @returns {Promise<{client: object, key: string}>}
 */
export async function rotateKey(name) {
  const client = await findByName(name);
  if (!client) return null;

  const plainKey = KEY_PREFIX_TAG + crypto.randomBytes(32).toString('hex');
  await knex(TABLE)
    .where({ name })
    .update({ key_hash: sha256(plainKey), key_prefix: plainKey.slice(0, 12), updated_at: knex.fn.now() });

  return { client: await findByName(name), key: plainKey };
}

/** 行 → 对外对象 */
function mapRow(row) {
  if (!row) return null;
  let allowed = [];
  try {
    allowed = JSON.parse(row.allowed_appids || '[]');
  } catch {
    allowed = [];
  }
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    allowedAppids: allowed,
    enabled: Boolean(row.enabled),
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 判断某调用方是否可访问指定 appid
 * @param {object} client mapRow 后的对象
 * @param {string} appid
 */
export function canAccessAppid(client, appid) {
  if (!client) return false;
  if (client.allowedAppids.includes('*')) return true;
  return client.allowedAppids.includes(appid);
}
