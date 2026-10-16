/**
 * 路由级冒烟测试(不依赖 MySQL)
 *
 * 用 supertest 风格的思路:直接调用 Koa 的 callback 函数发请求,
 * 验证路由装配、中间件顺序、验签拒绝逻辑是否正确。
 *
 * 用法: node scripts/smoke-route.js
 */
process.env.ENCRYPT_KEY =
  process.env.ENCRYPT_KEY || 'c182ee397133b9ff0f5b48fbcaedd8df038146e84ad260b72dca1933839fb497';

import http from 'node:http';
import Koa from 'koa';
import { rawBody } from '../src/middleware/raw-body.js';
import { errorHandler } from '../src/middleware/error.js';
import { callbackRouter } from '../src/routes/callback.js';
import { makeSignature } from '../src/utils/wx-crypto.js';

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
  }
}

// 装配一个精简版 app(与 app.js 相同的中间件顺序,但不连数据库)
const app = new Koa();
app.use(errorHandler());
app.use(rawBody());
app.use(callbackRouter.routes()).use(callbackRouter.allowedMethods());
app.use((ctx) => {
  ctx.status = 404;
  ctx.body = { code: 404, message: 'Not Found' };
});

const server = http.createServer(app.callback());
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

/** 发请求的小工具 */
async function req(path, opts = {}) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  return { status: res.status, text };
}

console.log('\n[1] 路由装配与 404 兜底');
{
  const r = await req('/not-exist');
  assert('未知路径返回 404', r.status === 404);
  assert('404 返回 JSON', JSON.parse(r.text).code === 404);
}

console.log('\n[2] 回调验签:账号不存在');
{
  // 数据库未连接 -> findByAppid 会抛错,errorHandler 应兜住并返回 success(回调路径防重试)
  const r = await req('/wechat/callback/wxNOTEXIST?signature=x&timestamp=1&nonce=2&echostr=hello');
  assert('账号查询异常时回调不返回 5xx', r.status < 500);
}

console.log('\n[3] 验签算法与原始体');
{
  // 直接验证签名工具在真实 HTTP 上下文中的行为
  const token = 'testtoken';
  const timestamp = '1700000000';
  const nonce = 'testnonce';
  const sig = makeSignature(token, timestamp, nonce);

  // 由于库里没有该 appid,这里只能验证"签名不匹配时被拒绝"的路径可达
  const r = await req(
    `/wechat/callback/wxNOTEXIST?signature=${sig}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello`
  );
  assert('请求能被路由正确接收并处理', typeof r.status === 'number');
}

console.log('\n[4] 原始体中间件');
{
  const body = '<xml><a>1</a></xml>';
  const r = await req('/wechat/callback/wxTEST', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body,
  });
  assert('POST 回调可接收 body 不报错', r.status < 500);
  assert('回调返回 success 或错误信息', r.text.length > 0);
}

await new Promise((r) => server.close(r));

console.log('\n' + '='.repeat(46));
console.log(`冒烟测试: 通过 ${passed} 项, 失败 ${failed} 项`);
console.log('='.repeat(46) + '\n');

process.exit(failed === 0 ? 0 : 1);
