/**
 * 新增 api_clients 表 —— 多项目密钥管理
 *
 * 设计要点:
 * 1. 密钥只存 SHA-256 哈希,明文仅在创建时返回一次(与 GitHub PAT 同一思路)
 * 2. allowed_appids 存 JSON 数组,如 ["wxAAA1","wxAAA2"];["*"] 表示可访问全部
 * 3. key_prefix 保存密钥前 8 位,便于管理页识别"这是哪把钥匙",无需解密
 */
export async function up(knex) {
  await knex.schema.createTable('api_clients', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable()
      .comment('项目名称,同时作为调用者身份(用于审计)');
    t.string('key_hash', 64).notNullable()
      .comment('SHA-256(明文密钥) 的十六进制,唯一');
    t.string('key_prefix', 12).notNullable()
      .comment('明文密钥前缀(如 wsk_1a2b3c4d),用于管理页识别');
    t.text('allowed_appids', 'longtext').notNullable().defaultTo('[]')
      .comment('允许访问的微信 appid 列表(JSON 数组),["*"] 表示全部');
    t.boolean('enabled').notNullable().defaultTo(true)
      .comment('是否启用;停用即吊销,立即生效');
    t.string('remark', 255).nullable().comment('备注');

    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.unique('name', 'uk_clients_name');
    t.unique('key_hash', 'uk_clients_key_hash');
    t.index('enabled', 'idx_clients_enabled');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('api_clients');
}
