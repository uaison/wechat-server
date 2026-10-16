/**
 * 初始化表结构
 *
 * 设计要点:
 * 1. wechat_accounts 以 appid 为主键 —— 多公众号/小程序的核心配置表
 * 2. app_secret / aes_key 存密文(应用层加密),密文长度留足空间
 * 3. 敏感字段用 TEXT 而非定长,避免密文膨胀后被截断
 */
export async function up(knex) {
  // ---------------- 微信账号配置表 ----------------
  await knex.schema.createTable('wechat_accounts', (t) => {
    t.string('appid', 64).primary().comment('微信 appid,唯一标识');
    t.string('type', 16).notNullable().defaultTo('official')
      .comment('账号类型: official=公众号, mini=小程序');
    t.string('name', 128).nullable().comment('账号名称,便于人眼识别');

    // 以下三个字段为密文存储(应用层 AES-256-GCM)
    t.text('app_secret', 'longtext').notNullable()
      .comment('AppSecret(密文)');
    t.text('token', 'longtext').nullable()
      .comment('消息推送配置的 Token(密文),用于验签');
    t.text('aes_key', 'longtext').nullable()
      .comment('EncodingAESKey(密文),43位,用于消息加解密');

    t.boolean('enabled').notNullable().defaultTo(true)
      .comment('是否启用;停用的号不参与 token 刷新');
    t.string('remark', 255).nullable().comment('备注');

    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index('type', 'idx_accounts_type');
    t.index('enabled', 'idx_accounts_enabled');
  });

  // ---------------- access_token 表 ----------------
  await knex.schema.createTable('access_tokens', (t) => {
    t.string('appid', 64).primary().comment('同 wechat_accounts.appid');
    t.text('token', 'longtext').notNullable()
      .comment('access_token 密文存储,防止库被读走即可冒用');
    t.timestamp('expires_at').notNullable()
      .comment('绝对过期时间(由微信 expires_in 换算,已含刷新边际)');
    t.timestamp('refreshed_at').notNullable()
      .comment('最近一次刷新时间,用于观测');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    // 便于定时任务快速捞出"临期/已过期"的号
    t.index('expires_at', 'idx_tokens_expires');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('access_tokens');
  await knex.schema.dropTableIfExists('wechat_accounts');
}
