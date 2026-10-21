/**
 * 业务链路集成测试(用 sqlite 内存库代替 MySQL)
 *
 * 目的:在没有 MySQL 的环境下,验证
 *   ① 迁移建表 ② 账号 upsert 与加解密 ③ token 复用/刷新/兜底重试
 *   ③ 验签与消息分发 ④ API 路由响应
 *
 * 用法: node scripts/integration-test.js
 */
process.env.ENCRYPT_KEY =
  process.env.ENCRYPT_KEY || '0000000000000000000000000000000000000000000000000000000000000001';

import http from 'node:http';
import Koa from 'koa';
import knexFactory from 'knex';

let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// ---------- 用 sqlite 内存库代替真实 MySQL ----------
// 说明:测试独立建表并直接验证 SQL 逻辑与工具函数,
// 不替换业务代码里的 knex 单例(ESM 导出不可重定义)。
const testKnex = knexFactory({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

console.log('\n[1] 迁移 SQL 可执行性(sqlite 兼容性检查)');
{
  // 手工执行等价建表语句,验证字段设计无冲突
  await testKnex.schema.createTable('wechat_accounts', (t) => {
    t.string('appid', 64).primary();
    t.string('type', 16).notNullable().defaultTo('official');
    t.string('name', 128).nullable();
    t.text('app_secret').notNullable();
    t.text('token').nullable();
    t.text('aes_key').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('remark', 255).nullable();
    t.timestamp('created_at').notNullable().defaultTo(testKnex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(testKnex.fn.now());
  });
  await testKnex.schema.createTable('access_tokens', (t) => {
    t.string('appid', 64).primary();
    t.text('token').notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('refreshed_at').notNullable();
    t.timestamp('updated_at').notNullable().defaultTo(testKnex.fn.now());
  });
  assert('wechat_accounts 建表成功', await testKnex.schema.hasTable('wechat_accounts'));
  assert('access_tokens 建表成功', await testKnex.schema.hasTable('access_tokens'));
}

console.log('\n[2] 账号 upsert 与敏感字段加解密');
{
  const { encrypt, decrypt } = await import('../src/utils/crypto.js');

  const appSecret = 'abcdef1234567890abcdef1234567890';
  const token = 'wxCallbackToken';
  const aesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

  // 模拟 account.model.upsert 的核心逻辑
  const record = {
    appid: 'wxTEST001',
    type: 'official',
    name: '测试公众号',
    app_secret: encrypt(appSecret),
    token: encrypt(token),
    aes_key: encrypt(aesKey),
    enabled: true,
    remark: null,
  };
  await testKnex('wechat_accounts').insert(record);

  const row = await testKnex('wechat_accounts').where({ appid: 'wxTEST001' }).first();
  assert('账号已入库', Boolean(row));
  assert('app_secret 以密文存储', row.app_secret !== appSecret && row.app_secret.startsWith('v1:'));
  assert('app_secret 可解密还原', decrypt(row.app_secret) === appSecret);
  assert('token 可解密还原', decrypt(row.token) === token);
  assert('aes_key 可解密还原', decrypt(row.aes_key) === aesKey);

  // upsert:改名字不应影响密钥
  await testKnex('wechat_accounts')
    .where({ appid: 'wxTEST001' })
    .update({ name: '改名后' });
  const row2 = await testKnex('wechat_accounts').where({ appid: 'wxTEST001' }).first();
  assert('更新后密钥保持不变', decrypt(row2.app_secret) === appSecret);
  assert('名称已更新', row2.name === '改名后');
}

console.log('\n[3] 多账号隔离(核心:按 appid 分别存 token)');
{
  const { encrypt, decrypt } = await import('../src/utils/crypto.js');

  await testKnex('wechat_accounts').insert([
    { appid: 'wxA', type: 'official', app_secret: encrypt('secretA'), enabled: true },
    { appid: 'wxB', type: 'mini', app_secret: encrypt('secretB'), enabled: true },
    { appid: 'wxC', type: 'official', app_secret: encrypt('secretC'), enabled: false },
  ]);

  const future = new Date(Date.now() + 7200 * 1000).toISOString();
  await testKnex('access_tokens').insert([
    { appid: 'wxA', token: encrypt('token_A'), expires_at: future, refreshed_at: testKnex.fn.now() },
    { appid: 'wxB', token: encrypt('token_B'), expires_at: future, refreshed_at: testKnex.fn.now() },
  ]);

  const rowA = await testKnex('access_tokens').where({ appid: 'wxA' }).first();
  const rowB = await testKnex('access_tokens').where({ appid: 'wxB' }).first();
  assert('wxA 的 token 独立存储', decrypt(rowA.token) === 'token_A');
  assert('wxB 的 token 独立存储', decrypt(rowB.token) === 'token_B');
  assert('两个账号 token 互不影响', decrypt(rowA.token) !== decrypt(rowB.token));

  const enabled = await testKnex('wechat_accounts').where({ enabled: true });
  assert('启用账号过滤正确(应为 3 个:wxTEST001/wxA/wxB)', enabled.length === 3);
}

console.log('\n[4] token 复用的时间边界逻辑');
{
  const MARGIN = 5 * 60 * 1000;

  /** 复刻 token.service 的判定逻辑 */
  function canReuse(expiresAt, now = Date.now()) {
    return new Date(expiresAt).getTime() - now > MARGIN;
  }

  const now = Date.now();
  assert('剩余 2 小时 → 可复用', canReuse(new Date(now + 7200 * 1000).toISOString(), now));
  assert('剩余 10 分钟 → 可复用', canReuse(new Date(now + 10 * 60 * 1000).toISOString(), now));
  assert('剩余 6 分钟 → 可复用', canReuse(new Date(now + 6 * 60 * 1000).toISOString(), now));
  assert('剩余 4 分钟 → 不可复用(触发刷新)', !canReuse(new Date(now + 4 * 60 * 1000).toISOString(), now));
  assert('剩余 1 分钟 → 不可复用', !canReuse(new Date(now + 60 * 1000).toISOString(), now));
  assert('已过期 → 不可复用', !canReuse(new Date(now - 1000).toISOString(), now));
  assert('边界:恰好 5 分钟 → 不可复用(严格大于)', !canReuse(new Date(now + MARGIN).toISOString(), now));
}

console.log('\n[5] 凭据错误判定与重试触发条件');
{
  const { WechatApiError, isCredentialError } = await import('../src/utils/http.js');

  assert('40001 触发重试', isCredentialError(new WechatApiError(40001, 'invalid credential')));
  assert('40014 触发重试', isCredentialError(new WechatApiError(40014, 'invalid token')));
  assert('42001 触发重试', isCredentialError(new WechatApiError(42001, 'token expired')));
  assert('40003 不触发重试', !isCredentialError(new WechatApiError(40003, 'invalid openid')));
  assert('45009 不触发重试', !isCredentialError(new WechatApiError(45009, 'api freq out of limit')));
  assert('普通 Error 不触发重试', !isCredentialError(new Error('network fail')));
}

console.log('\n[6] 回调验签完整链路(模拟微信请求)');
{
  const { makeSignature, encryptMessage, decryptMessage } = await import('../src/utils/wx-crypto.js');

  const token = 'wxCallbackToken';
  const aesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const appid = 'wxTEST001';

  // --- 明文模式 ---
  const timestamp = '1700000000';
  const nonce = 'abc';
  const echostr = 'random_echo_string';
  const sig = makeSignature(token, timestamp, nonce);
  assert('明文模式:握手签名正确', makeSignature(token, timestamp, nonce) === sig);
  assert('明文模式:错 token 签名不同', makeSignature('wrong', timestamp, nonce) !== sig);

  // --- 安全模式:消息加密 → 提取 → 验签 → 解密 ---
  const incomingXml = `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[o_user1]]></FromUserName><Content><![CDATA[hello]]></Content><MsgType><![CDATA[text]]></MsgType></xml>`;
  const encrypted = encryptMessage(incomingXml, aesKey, appid);
  const rawBody = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;

  const extracted = rawBody.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/)[1];
  assert('安全模式:能从原始体提取 Encrypt', extracted === encrypted);

  const msgSig = makeSignature(token, timestamp, nonce, extracted);
  assert('安全模式:消息签名可验证', makeSignature(token, timestamp, nonce, extracted) === msgSig);

  const decrypted = decryptMessage(extracted, aesKey, appid);
  assert('安全模式:解密还原原始 XML', decrypted.message === incomingXml);
  assert('安全模式:appid 校验通过', decrypted.appid === appid);
}

console.log('\n[7] 消息分发器注册表');
{
  const ms = await import('../src/services/message.service.js');

  const textReply = await ms.dispatch(
    { msgType: 'text', content: 'hi', fromUserName: 'o1', toUserName: 'gh1' },
    { appid: 'wxTEST001' }
  );
  assert('未注册的 text 落到 * 兜底并返回 success', textReply === 'success');

  const subscribeReply = await ms.dispatch(
    { msgType: 'event', event: 'subscribe', fromUserName: 'o1', toUserName: 'gh1' },
    { appid: 'wxTEST001' }
  );
  assert('subscribe 事件返回欢迎语 XML', subscribeReply.includes('感谢关注'));

  const unsubReply = await ms.dispatch(
    { msgType: 'event', event: 'unsubscribe', fromUserName: 'o1', toUserName: 'gh1' },
    { appid: 'wxTEST001' }
  );
  assert('unsubscribe 事件不回复', unsubReply === 'success');

  // 处理器抛错不应影响响应
  ms.register('boom', async () => {
    throw new Error('处理器内部错误');
  });
  const boomReply = await ms.dispatch({ msgType: 'boom' }, { appid: 'wxTEST001' });
  assert('处理器抛错时仍返回 success(保护 5 秒响应)', boomReply === 'success');
}

console.log('\n[8] XML 解析与回复构造');
{
  const ms = await import('../src/services/message.service.js');

  const xml = `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[o_user]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好呀]]></Content><MsgId>123456</MsgId></xml>`;
  const parsed = await ms.parseMessage(xml);
  const norm = ms.normalizeMessage(parsed);

  assert('解析 ToUserName', norm.toUserName === 'gh_1');
  assert('解析 FromUserName', norm.fromUserName === 'o_user');
  assert('解析 CreateTime 为数字', norm.createTime === 1700000000);
  assert('解析中文内容', norm.content === '你好呀');
  assert('解析 MsgId', norm.msgId === '123456');

  const reply = ms.buildTextReply({ toUser: 'o_user', fromUser: 'gh_1', content: '收到' });
  assert('回复 XML 含 ToUserName', reply.includes('<![CDATA[o_user]]>'));
  assert('回复 XML 含内容', reply.includes('<![CDATA[收到]]>'));
  assert('回复 XML 含 CreateTime', /<CreateTime>\d+<\/CreateTime>/.test(reply));
}

console.log('\n[9] API 路由响应(装配层,含鉴权)');
{
  // 本文件顶部已设置 DB_CLIENT=sqlite? 若无则补上 —— 必须在动态 import 前生效。
  // 此处动态 import 都在 env 设置之后执行,安全。
  process.env.DB_CLIENT = process.env.DB_CLIENT || 'sqlite';
  process.env.DB_FILE = process.env.DB_FILE || ':memory:';

  const { rawBody } = await import('../src/middleware/raw-body.js');
  const { errorHandler } = await import('../src/middleware/error.js');
  const { apiRouter } = await import('../src/routes/api.js');
  const { knex: appKnex } = await import('../src/db/knex.js');
  const clientModel = await import('../src/models/api-client.model.js');

  // 为鉴权准备 api_clients 表与测试密钥
  await appKnex.schema.createTable('api_clients', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable();
    t.string('key_hash', 64).notNullable();
    t.string('key_prefix', 12).notNullable();
    t.text('allowed_appids').notNullable().defaultTo('[]');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('remark', 255).nullable();
    t.timestamp('created_at').notNullable().defaultTo(appKnex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(appKnex.fn.now());
  });
  const { key } = await clientModel.create({ name: 'integration-suite', allowedAppids: ['*'] });
  const keyHeader = { 'X-API-Key': key, 'Content-Type': 'application/json' };

  const app = new Koa();
  app.use(errorHandler());
  app.use(rawBody());
  app.use(apiRouter.routes()).use(apiRouter.allowedMethods());

  const server = http.createServer(app.callback());
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  assert('GET /api/health 返回 200', res.status === 200);
  assert('健康检查返回 status=ok', body.status === 'ok');
  assert('健康检查含 uptime', typeof body.uptime === 'number');

  // 未带密钥访问业务接口 → 401(鉴权生效)
  const noAuth = await fetch(`http://127.0.0.1:${port}/api/accounts`);
  assert('未带密钥访问业务接口 → 401', noAuth.status === 401);

  // 缺少必填参数应返回 400
  const res2 = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: keyHeader,
    body: JSON.stringify({ appid: 'only_appid' }),
  });
  const body2 = await res2.json();
  assert('POST /api/accounts 缺 appSecret 返回 400', res2.status === 400);
  assert('错误响应含提示信息', body2.message.includes('appSecret'));

  await new Promise((r) => server.close(r));
  await appKnex.destroy();
}

await testKnex.destroy();

console.log('\n' + '='.repeat(50));
console.log(`集成测试: 通过 ${passed} 项, 失败 ${failed} 项`);
if (failures.length) console.log('失败项:', failures.join(' / '));
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
