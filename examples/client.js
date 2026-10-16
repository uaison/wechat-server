/**
 * 微信服务端 API 调用示例
 *
 * 演示如何从你的业务后端调用本服务。
 * 用法:
 *   node examples/client.js health
 *   node examples/client.js accounts
 *   node examples/client.js add-account
 *   node examples/client.js check-token
 *   node examples/client.js mini-login <code>
 *   node examples/client.js send-text <openid> <内容>
 *   node examples/client.js user <openid>
 *   node examples/client.js all
 *
 * 配置(环境变量,或直接改下面的默认值):
 *   BASE_URL   服务地址,默认 http://127.0.0.1:3000
 *   APPID      要操作的账号 appid
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const APPID = process.env.APPID || 'wx1234567890abcdef';

/**
 * 统一请求封装
 *
 * 设计原则:调用者只关心"要什么",不关心 token、重试、错误解析。
 *
 * 注意:/api/health 是基础设施接口,返回的是裸对象(无 code 包装),
 *      其余业务接口统一返回 { code, data, message }。
 *
 * ⚠️ 如果运行时报 "fetch failed",多半是开发机配置了 HTTP_PROXY 环境变量,
 *    Node 的 fetch 会把请求也发给代理。本地调试时清掉代理即可:
 *      env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
 *        BASE_URL=http://127.0.0.1:3000 node examples/client.js all
 */
async function api(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`响应不是 JSON (HTTP ${res.status}): ${url}`);
  }

  // 健康检查等基础设施接口:不套 code 包装
  if (!('code' in data)) {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return data;
  }

  if (data.code !== 0) {
    const err = new Error(`${data.message || '调用失败'}${data.detail ? ` (${data.detail})` : ''}`);
    err.code = data.code;
    err.raw = data;
    throw err;
  }
  return data.data;
}

/** 打印带标题的结果 */
function show(title, data) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`▶ ${title}`);
  console.log('─'.repeat(50));
  console.log(JSON.stringify(data, null, 2));
}

// ============================================================
// 各接口示例
// ============================================================

/** 健康检查 */
async function health() {
  const data = await api('/api/health');
  show('健康检查', data);
  return data;
}

/** 列出账号 */
async function accounts() {
  const data = await api('/api/accounts');
  show(`账号列表 (共 ${data.length} 个)`, data);

  // 顺手提示配置问题
  for (const a of data) {
    if (a.type === 'official' && (!a.hasToken || !a.hasAesKey)) {
      console.log(`  ⚠️  ${a.appid} 缺少 ${!a.hasToken ? 'Token' : ''}${!a.hasAesKey ? ' EncodingAESKey' : ''},回调将失败`);
    }
  }
  return data;
}

/** 新增账号(示例:演示如何录入) */
async function addAccount() {
  const data = await api('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      appid: APPID,
      appSecret: process.env.APP_SECRET || '你的AppSecret',
      type: process.env.TYPE || 'official',
      name: process.env.NAME || '示例公众号',
      token: process.env.WX_TOKEN || 'myToken123',
      aesKey: process.env.AES_KEY || 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      remark: '由 examples/client.js 录入',
    }),
  });
  show('账号已保存', data);
  console.log(`\n💡 下一步:验证 AppSecret 是否正确`);
  console.log(`   node examples/client.js check-token`);
  return data;
}

/** 验证 AppSecret + 查看 token 状态 */
async function checkToken() {
  console.log(`\n[1/2] 强制刷新 token(同时验证 AppSecret)...`);
  const refreshed = await api(`/api/token/${APPID}/refresh`, { method: 'POST' });
  show('刷新结果', refreshed);
  console.log('✅ AppSecret 有效');

  console.log(`\n[2/2] 查询 token 状态...`);
  const status = await api(`/api/token/${APPID}/status`);
  show('token 状态', status);

  if (status.cached) {
    console.log(`   剩余有效时间: ${status.remainingSeconds} 秒`);
    console.log(`   是否可用: ${status.valid ? '✅' : '❌ 下次调用会自动刷新'}`);
  }
  return status;
}

/** 批量预热所有账号 */
async function warmup() {
  const data = await api('/api/token/warmup', { method: 'POST' });
  show('批量预热结果', data);

  if (data.failed.length > 0) {
    console.log(`\n⚠️  ${data.failed.length} 个账号失败:`);
    for (const f of data.failed) {
      console.log(`   ${f.appid}: ${f.error}`);
    }
  } else {
    console.log('\n✅ 全部账号 token 就绪');
  }
  return data;
}

/** 小程序 code 换 openid */
async function miniLogin(code) {
  if (!code) throw new Error('用法: node examples/client.js mini-login <code>');

  const data = await api('/api/mini/session', {
    method: 'POST',
    body: JSON.stringify({ appid: APPID, code }),
  });

  // ★ 安全提醒:session_key 是敏感数据,实战中必须留在服务端!
  show('小程序登录结果', {
    openid: data.openid,
    unionid: data.unionid,
    session_key: data.session_key ? '（已获取,实战中请勿返回给前端）' : undefined,
  });
  return data;
}

/** 发送客服消息 */
async function sendText(openid, content) {
  if (!openid) {
    throw new Error('用法: node examples/client.js send-text <openid> <内容>');
  }

  const data = await api('/api/message/custom/send', {
    method: 'POST',
    body: JSON.stringify({
      appid: APPID,
      message: {
        touser: openid,
        msgtype: 'text',
        text: { content: content || '这是一条测试消息' },
      },
    }),
  });
  show('客服消息已发送', data);
  console.log('\n💡 请到微信中查看是否收到');
  return data;
}

/** 获取用户信息 */
async function user(openid) {
  if (!openid) throw new Error('用法: node examples/client.js user <openid>');

  const data = await api(`/api/user/${APPID}/${openid}`);
  show('用户信息', data);
  return data;
}

// ============================================================
// 命令行入口
// ============================================================

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

const commands = {
  health,
  accounts,
  'add-account': addAccount,
  'check-token': checkToken,
  warmup,
  'mini-login': () => miniLogin(arg1),
  'send-text': () => sendText(arg1, arg2),
  user: () => user(arg1),
};

/** 完整巡检流程 */
async function runAll() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║       微信服务端 API 完整巡检                  ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`服务地址: ${BASE}`);
  console.log(`目标账号: ${APPID}`);

  try {
    await health();
    await accounts();
    await checkToken();
  } catch (err) {
    console.error(`\n❌ 巡检中断: ${err.message}`);
    if (err.code) console.error(`   错误码: ${err.code}`);
    process.exitCode = 1;
  }
}

async function main() {
  if (!command) {
    console.log(`
微信服务端 API 调用示例

用法:
  node examples/client.js <命令> [参数]

命令:
  health                        健康检查
  accounts                      列出所有账号
  add-account                   新增/更新账号(读环境变量)
  check-token                   验证 AppSecret 并查看 token 状态
  warmup                        批量预热所有账号 token
  mini-login <code>             小程序 code 换 openid
  send-text <openid> <内容>      发送客服消息
  user <openid>                 获取用户信息
  all                           完整巡检流程

环境变量:
  BASE_URL     服务地址(默认 http://127.0.0.1:3000)
  APPID        账号 appid
  APP_SECRET   录入账号时用
  WX_TOKEN     录入账号时用(回调 Token)
  AES_KEY      录入账号时用(EncodingAESKey)

示例:
  BASE_URL=https://wechat.yourdomain.com APPID=wx123 node examples/client.js all
`);
    return;
  }

  if (command === 'all') {
    await runAll();
    return;
  }

  const fn = commands[command];
  if (!fn) {
    console.error(`未知命令: ${command}`);
    console.error(`可用命令: ${Object.keys(commands).join(', ')}, all`);
    process.exit(1);
  }

  try {
    await fn();
  } catch (err) {
    console.error(`\n❌ 调用失败: ${err.message}`);
    if (err.code) console.error(`   错误码: ${err.code}`);
    process.exit(1);
  }
}

main();
