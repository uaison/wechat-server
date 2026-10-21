/**
 * 本地演示服务(用 sqlite 内存库替代 MySQL)
 *
 * 目的:让 examples/client.js 可以在没有 MySQL 的环境里完整跑通,
 * 用于验证接口契约与调用示例的正确性。
 *
 * 用法: node examples/demo-server.js
 * 然后另开终端: BASE_URL=http://127.0.0.1:3001 node examples/client.js all
 */
// 演示用的假密钥,仅本地跑通流程用;生产必须用 `npm run keygen` 生成
process.env.ENCRYPT_KEY =
  process.env.ENCRYPT_KEY || '0000000000000000000000000000000000000000000000000000000000000001';

import http from 'node:http';
import Koa from 'koa';
import knexFactory from 'knex';
import { rawBody } from '../src/middleware/raw-body.js';
import { errorHandler } from '../src/middleware/error.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';

const PORT = Number.parseInt(process.env.PORT || '3001', 10);

const db = knexFactory({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

// ---------- 建表 ----------
await db.schema.createTable('wechat_accounts', (t) => {
  t.string('appid', 64).primary();
  t.string('type', 16).notNullable().defaultTo('official');
  t.string('name', 128).nullable();
  t.text('app_secret').notNullable();
  t.text('token').nullable();
  t.text('aes_key').nullable();
  t.boolean('enabled').notNullable().defaultTo(true);
  t.string('remark', 255).nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
});

await db.schema.createTable('access_tokens', (t) => {
  t.string('appid', 64).primary();
  t.text('token').notNullable();
  t.timestamp('expires_at').notNullable();
  t.timestamp('refreshed_at').notNullable();
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
});

console.log('[demo] 内存数据库已就绪');

// ---------- 路由 ----------
const app = new Koa();
app.use(errorHandler());
app.use(rawBody());

app.use(async (ctx, next) => {
  const { path, method } = ctx;
  const body = ctx.request.rawBody ? safeParse(ctx.request.rawBody) : {};

  // 健康检查
  if (method === 'GET' && path === '/api/health') {
    ctx.body = {
      status: 'ok',
      env: 'demo',
      time: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    };
    return;
  }

  // 账号列表
  if (method === 'GET' && path === '/api/accounts') {
    const rows = await db('wechat_accounts').orderBy('created_at', 'desc');
    ctx.body = {
      code: 0,
      data: rows.map((r) => ({
        appid: r.appid,
        type: r.type,
        name: r.name,
        enabled: Boolean(r.enabled),
        remark: r.remark,
        hasToken: Boolean(r.token),
        hasAesKey: Boolean(r.aes_key),
        createdAt: r.created_at,
      })),
    };
    return;
  }

  // 新增账号
  if (method === 'POST' && path === '/api/accounts') {
    if (!body.appid || !body.appSecret) {
      ctx.status = 400;
      ctx.body = { code: 400, message: 'appid 与 appSecret 为必填' };
      return;
    }
    const record = {
      appid: body.appid,
      type: body.type || 'official',
      name: body.name || null,
      app_secret: encrypt(body.appSecret),
      token: body.token ? encrypt(body.token) : null,
      aes_key: body.aesKey ? encrypt(body.aesKey) : null,
      enabled: body.enabled !== false,
      remark: body.remark || null,
      updated_at: db.fn.now(),
    };
    await db('wechat_accounts')
      .insert({ ...record, created_at: db.fn.now() })
      .onConflict('appid')
      .merge(['type', 'name', 'app_secret', 'token', 'aes_key', 'enabled', 'remark', 'updated_at']);

    ctx.body = { code: 0, message: '保存成功', data: { appid: body.appid } };
    return;
  }

  // token 状态
  if (method === 'GET' && path.startsWith('/api/token/') && path.endsWith('/status')) {
    const appid = path.split('/')[3];
    const row = await db('access_tokens').where({ appid }).first();
    if (!row) {
      ctx.body = { code: 0, data: { appid, cached: false } };
      return;
    }
    const expiresAt = new Date(row.expires_at).getTime();
    ctx.body = {
      code: 0,
      data: {
        appid,
        cached: true,
        expiresAt: row.expires_at,
        refreshedAt: row.refreshed_at,
        remainingSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
        valid: expiresAt - Date.now() > 5 * 60 * 1000,
      },
    };
    return;
  }

  // 刷新 token(demo 环境模拟成功,不真调微信)
  if (method === 'POST' && path.startsWith('/api/token/') && path.endsWith('/refresh')) {
    const appid = path.split('/')[3];
    const account = await db('wechat_accounts').where({ appid }).first();
    if (!account) {
      ctx.status = 404;
      ctx.body = { code: 404, message: '账号未配置' };
      return;
    }
    const fakeToken = `demo_token_${Date.now()}_${'x'.repeat(80)}`;
    const expiresAt = new Date(Date.now() + 7200 * 1000).toISOString();
    await db('access_tokens')
      .insert({
        appid,
        token: encrypt(fakeToken),
        expires_at: expiresAt,
        refreshed_at: db.fn.now(),
        updated_at: db.fn.now(),
      })
      .onConflict('appid')
      .merge(['token', 'expires_at', 'refreshed_at', 'updated_at']);

    ctx.body = { code: 0, message: '刷新成功', data: { appid, length: fakeToken.length } };
    return;
  }

  // 批量预热
  if (method === 'POST' && path === '/api/token/warmup') {
    const rows = await db('wechat_accounts').where({ enabled: true });
    const ok = [];
    const failed = [];
    for (const r of rows) {
      if (!decrypt(r.app_secret)) {
        failed.push({ appid: r.appid, error: 'AppSecret 解密失败' });
      } else {
        ok.push(r.appid);
      }
    }
    ctx.body = { code: 0, data: { ok, failed } };
    return;
  }

  // 小程序 session(demo 模拟)
  if (method === 'POST' && path === '/api/mini/session') {
    if (!body.appid || !body.code) {
      ctx.status = 400;
      ctx.body = { code: 400, message: 'appid 与 code 为必填' };
      return;
    }
    const account = await db('wechat_accounts').where({ appid: body.appid }).first();
    if (!account) {
      ctx.status = 404;
      ctx.body = { code: 404, message: '账号未配置' };
      return;
    }
    ctx.body = {
      code: 0,
      data: {
        openid: `o_demo_${body.code.slice(0, 8)}`,
        session_key: 'ZGVtb19zZXNzaW9uX2tleV9leGFtcGxl==',
        unionid: 'u_demo_unionid',
      },
    };
    return;
  }

  // 发客服消息(demo 模拟)
  if (method === 'POST' && path === '/api/message/custom/send') {
    if (!body.appid || !body.message) {
      ctx.status = 400;
      ctx.body = { code: 400, message: 'appid 与 message 为必填' };
      return;
    }
    ctx.body = { code: 0, data: { errcode: 0, errmsg: 'ok' } };
    return;
  }

  // 用户信息(demo 模拟)
  if (method === 'GET' && path.startsWith('/api/user/')) {
    const openid = path.split('/')[4];
    ctx.body = {
      code: 0,
      data: {
        subscribe: 1,
        openid,
        nickname: '演示用户😀',
        sex: 1,
        city: '深圳',
        headimgurl: 'https://thirdwx.qlogo.cn/demo',
        subscribe_time: 1700000000,
      },
    };
    return;
  }

  await next();
});

app.use((ctx) => {
  ctx.status = 404;
  ctx.body = { code: 404, message: 'Not Found' };
});

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

const server = http.createServer(app.callback());
server.listen(PORT, () => {
  console.log(`[demo] 演示服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`[demo] 试运行: BASE_URL=http://127.0.0.1:${PORT} node examples/client.js all`);
});

process.on('SIGINT', async () => {
  await db.destroy();
  server.close(() => process.exit(0));
});
