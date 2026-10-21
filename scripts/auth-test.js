/**
 * 多项目密钥管理 · 集成测试(sqlite 内存库 + 真实中间件)
 *
 * 全部走真实代码路径:模型层、鉴权中间件、HTTP 装配。
 * 通过 DB_CLIENT=sqlite 环境变量让 src/db/knex.js 切换到内存库。
 *
 * 用法: node scripts/auth-test.js
 */
// ⚠️ 必须在动态 import 之前设置 —— ESM 静态 import 会被提升,
// 而下面的动态 import() 在赋值之后才执行,config 才能读到这些值。
process.env.ENCRYPT_KEY = process.env.ENCRYPT_KEY || '0000000000000000000000000000000000000000000000000000000000000001';
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'admin_test_key_12345';
process.env.DB_CLIENT = 'sqlite';
process.env.DB_FILE = ':memory:';

const http = await import('node:http');
const Koa = (await import('koa')).default;
const { rawBody } = await import('../src/middleware/raw-body.js');
const { errorHandler } = await import('../src/middleware/error.js');
const { apiAuth, adminAuth } = await import('../src/middleware/auth.js');
const clientModel = await import('../src/models/api-client.model.js');
const { knex } = await import('../src/db/knex.js');
const { sha256 } = await import('../src/utils/crypto.js');

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

// ---------- 建表(sqlite) ----------
await knex.schema.createTable('api_clients', (t) => {
  t.increments('id').primary();
  t.string('name', 64).notNullable();
  t.string('key_hash', 64).notNullable();
  t.string('key_prefix', 12).notNullable();
  t.text('allowed_appids').notNullable().defaultTo('[]');
  t.boolean('enabled').notNullable().defaultTo(true);
  t.string('remark', 255).nullable();
  t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
});

// ---------- 装配真实应用 ----------
const app = new Koa();
app.use(errorHandler());
app.use(rawBody());

// 路由:@koa/router 会解析 :appid 到 ctx.params
const Router = (await import('@koa/router')).default;
const testRouter = new Router();

// ⚠️ 注册顺序:router.use() 只对其后注册的路由生效。
// ① 先注册公开路由(health) → ② 再挂鉴权 → ③ 最后注册受保护路由。
testRouter.get('/api/health', (ctx) => { ctx.body = { status: 'ok' }; });

testRouter.use('/api/token', apiAuth());
testRouter.use('/api/mini', apiAuth());
testRouter.use('/api/accounts', apiAuth());

testRouter.get('/api/accounts', (ctx) => {
  ctx.body = { code: 0, data: { calledBy: ctx.state.client?.name } };
});
testRouter.get('/api/token/:appid/status', (ctx) => {
  ctx.body = { code: 0, data: { appid: ctx.params.appid, calledBy: ctx.state.client?.name } };
});
testRouter.post('/api/mini/session', (ctx) => {
  ctx.body = { code: 0, data: { appid: JSON.parse(ctx.request.rawBody).appid } };
});
// 批量预热:路径里没有 appid,不应被 appid 授权校验误拦
testRouter.post('/api/token/warmup', (ctx) => {
  ctx.body = { code: 0, data: { ok: ['wxAAA1'], failed: [] } };
});

app.use(testRouter.routes()).use(testRouter.allowedMethods());

// 真实的密钥管理路由(自带 adminAuth)
const { clientsRouter } = await import('../src/routes/clients.js');
app.use(clientsRouter.routes()).use(clientsRouter.allowedMethods());
app.use((ctx) => { ctx.status = 404; ctx.body = { code: 404 }; });

const server = http.createServer(app.callback());
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const req = async (path, opts = {}) => {
  const res = await fetch(base + path, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const authed = (key) => ({ headers: { 'X-API-Key': key } });
const admined = () => ({ headers: { 'X-Admin-Key': 'admin_test_key_12345' } });

console.log('\n[1] 密钥签发(真实模型层)');
{
  const { client, key } = await clientModel.create({
    name: '项目A',
    allowedAppids: ['wxAAA1', 'wxAAA2'],
    remark: '测试项目A',
  });
  assert('返回 client 对象', client?.name === '项目A');
  assert('明文密钥以 wsk_ 开头', key.startsWith('wsk_'));
  assert('明文密钥长 68 字符', key.length === 68);
  assert('库中不存明文(仅 keyPrefix)', client.keyPrefix.length === 12 && !JSON.stringify(client).includes(key));

  // 数据库里确实只有哈希
  const row = await knex('api_clients').where({ name: '项目A' }).first();
  assert('库中 key_hash = sha256(明文)', row.key_hash === sha256(key));
  assert('授权列表已入库', JSON.parse(row.allowed_appids).includes('wxAAA1'));
  globalThis.keyA = key;
}

console.log('\n[2] 鉴权中间件(真实 HTTP 链路)');
{
  const health = await req('/api/health');
  assert('/api/health 公开可访问', health.status === 200);

  const noKey = await req('/api/accounts');
  assert('缺失密钥 → 401', noKey.status === 401);
  assert('401 提示提供方式', noKey.body.message.includes('Authorization'));

  const badKey = await req('/api/accounts', authed('wsk_notexist'));
  assert('无效密钥 → 401', badKey.status === 401);

  const bearer = await req('/api/accounts', { headers: { Authorization: `Bearer ${globalThis.keyA}` } });
  assert('Bearer 头可用且识别身份', bearer.status === 200 && bearer.body.data.calledBy === '项目A');

  const xkey = await req('/api/accounts', authed(globalThis.keyA));
  assert('X-API-Key 头可用', xkey.status === 200 && xkey.body.data.calledBy === '项目A');
}

console.log('\n[3] appid 授权隔离(真实路由参数)');
{
  const ok = await req('/api/token/wxAAA1/status', authed(globalThis.keyA));
  assert('授权内 appid → 200', ok.status === 200 && ok.body.data.appid === 'wxAAA1');

  const deny = await req('/api/token/wxBBB1/status', authed(globalThis.keyA));
  assert('越权 appid → 403', deny.status === 403);
  assert('403 信息含项目名与 appid', deny.body.message.includes('项目A') && deny.body.message.includes('wxBBB1'));

  // 请求体里的 appid 也要校验
  const okBody = await req('/api/mini/session', {
    ...authed(globalThis.keyA),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': globalThis.keyA },
    body: JSON.stringify({ appid: 'wxAAA2', code: 'x' }),
  });
  assert('请求体 appid 授权内 → 200', okBody.status === 200);

  const denyBody = await req('/api/mini/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': globalThis.keyA },
    body: JSON.stringify({ appid: 'wxBBB1', code: 'x' }),
  });
  assert('请求体 appid 越权 → 403', denyBody.status === 403);

  // ★ 回归防护:/api/token/warmup 里的 "warmup" 是动作名而非 appid,
  //   密钥只授权了具体 appid(无 * 通配)时也必须放行,
  //   否则"遍历自己所有账号预热"这一合法操作会被误拦。
  const warmup = await req('/api/token/warmup', {
    method: 'POST',
    ...authed(globalThis.keyA),
  });
  assert('warmup 不被误判为 appid(无通配密钥也能调) → 200', warmup.status === 200);
}

console.log('\n[4] 管理接口(ADMIN_KEY 保护)');
{
  const noKey = await req('/api/clients');
  assert('无管理员密钥 → 401', noKey.status === 401);

  const badKey = await req('/api/clients', { headers: { 'X-Admin-Key': 'wrong' } });
  assert('错误管理员密钥 → 401', badKey.status === 401);

  const ok = await req('/api/clients', admined());
  assert('正确管理员密钥 → 200', ok.status === 200);
  assert('列表包含项目A', Array.isArray(ok.body.data) && ok.body.data.some((c) => c.name === '项目A'));

  // 通过管理接口签发项目B
  const created = await req('/api/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin_test_key_12345' },
    body: JSON.stringify({ name: '项目B', allowedAppids: ['wxBBB1'] }),
  });
  assert('签发项目B成功', created.status === 200 && created.body.data.key.startsWith('wsk_'));
  globalThis.keyB = created.body.data.key;
}

console.log('\n[5] 吊销即时生效');
{
  // 项目B 先正常访问
  const before = await req('/api/token/wxBBB1/status', authed(globalThis.keyB));
  assert('吊销前项目B可访问', before.status === 200);

  // 吊销
  const revoked = await req('/api/clients/项目B/disable', {
    method: 'POST',
    headers: { 'X-Admin-Key': 'admin_test_key_12345' },
  });
  assert('吊销操作成功', revoked.status === 200);

  const after = await req('/api/token/wxBBB1/status', authed(globalThis.keyB));
  assert('吊销后同一密钥 → 401', after.status === 401);

  // 项目A 不受影响
  const aStill = await req('/api/token/wxAAA1/status', authed(globalThis.keyA));
  assert('项目A 不受项目B 吊销影响', aStill.status === 200);

  // 重新启用
  await req('/api/clients/项目B/enable', { method: 'POST', headers: { 'X-Admin-Key': 'admin_test_key_12345' } });
  const reEnabled = await req('/api/token/wxBBB1/status', authed(globalThis.keyB));
  assert('重新启用后可访问', reEnabled.status === 200);
}

console.log('\n[6] 密钥轮换');
{
  const rotated = await req('/api/clients/项目B/rotate', {
    method: 'POST',
    headers: { 'X-Admin-Key': 'admin_test_key_12345' },
  });
  assert('轮换成功并返回新密钥', rotated.status === 200 && rotated.body.data.key.startsWith('wsk_'));

  const newKey = rotated.body.data.key;
  const oldGone = await req('/api/token/wxBBB1/status', authed(globalThis.keyB));
  assert('旧密钥立即失效 → 401', oldGone.status === 401);

  const newOk = await req('/api/token/wxBBB1/status', authed(newKey));
  assert('新密钥可访问', newOk.status === 200);
  globalThis.keyB = newKey;
}

console.log('\n[7] 通配授权与管理员密钥隔离');
{
  // 给项目B 升级为通配
  await req('/api/clients/项目B', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin_test_key_12345' },
    body: JSON.stringify({ allowedAppids: ['*'] }),
  });
  const anyAppid = await req('/api/token/wxAny000/status', authed(globalThis.keyB));
  assert('通配后可访问任意 appid', anyAppid.status === 200);

  // 管理员密钥不是业务密钥:不能调业务接口
  const adminAsBiz = await req('/api/accounts', { headers: { 'X-API-Key': 'admin_test_key_12345' } });
  assert('ADMIN_KEY 不能当业务密钥用 → 401', adminAsBiz.status === 401);

  // 业务密钥不能调管理接口
  const bizAsAdmin = await req('/api/clients', { headers: { 'X-Admin-Key': globalThis.keyB } });
  assert('业务密钥不能调管理接口 → 401', bizAsAdmin.status === 401);
}

await new Promise((r) => server.close(r));
await knex.destroy();

console.log('\n' + '='.repeat(50));
console.log(`密钥管理测试: 通过 ${passed} 项, 失败 ${failed} 项`);
if (failures.length) console.log('失败项:', failures.join(' / '));
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
