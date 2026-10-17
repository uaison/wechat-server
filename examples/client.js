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
 * 鉴权(自动附加,按环境变量):
 *   API_KEY    → X-API-Key 头,访问业务接口(/api/accounts 等)
 *   ADMIN_KEY  → X-Admin-Key 头,访问密钥管理接口(/api/clients)
 *   两者职责不同:ADMIN_KEY 只管签发/吊销密钥,不能调业务接口。
 *
 * ⚠️ 如果运行时报 "fetch failed",多半是开发机配置了 HTTP_PROXY 环境变量,
 *    Node 的 fetch 会把请求也发给代理。本地调试时清掉代理即可:
 *      env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
 *        BASE_URL=http://127.0.0.1:3000 node examples/client.js all
 */
async function api(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.API_KEY) headers['X-API-Key'] = process.env.API_KEY;
  if (process.env.ADMIN_KEY) headers['X-Admin-Key'] = process.env.ADMIN_KEY;

  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
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
// 密钥管理(需要 ADMIN_KEY 环境变量)
// ============================================================

/** 列出所有调用方密钥 */
async function clients() {
  const data = await api('/api/clients');
  show(`API 密钥列表 (共 ${data.length} 个项目)`, data.map((c) => ({
    name: c.name,
    keyPrefix: c.keyPrefix,
    allowedAppids: c.allowedAppids,
    enabled: c.enabled,
    remark: c.remark,
  })));
  return data;
}

/** 为新项目签发密钥 */
async function createClient(name, appids) {
  if (!name) throw new Error('用法: node examples/client.js create-client <项目名> [appid1,appid2,...]');

  const allowedAppids = appids
    ? appids.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const data = await api('/api/clients', {
    method: 'POST',
    body: JSON.stringify({ name, allowedAppids }),
  });

  console.log(`\n════════════════════════════════════════`);
  console.log(`  项目 ${name} 的密钥已签发`);
  console.log(`  密钥: ${data.key}`);
  console.log(`  授权: ${allowedAppids.length ? allowedAppids.join(', ') : '(空,需 PATCH 补充)'}`);
  console.log(`════════════════════════════════════════`);
  console.log(`⚠️  此密钥仅显示这一次,请立即交给项目方保存!`);
  console.log(`项目方调用方式: 请求头 X-API-Key: <密钥>`);
  return data;
}

/** 吊销某项目的密钥 */
async function disableClient(name) {
  if (!name) throw new Error('用法: node examples/client.js disable-client <项目名>');
  const data = await api(`/api/clients/${encodeURIComponent(name)}/disable`, { method: 'POST' });
  show(`项目 ${name} 已吊销`, data);
  console.log('该项目的下一次请求将立即返回 401');
  return data;
}

/** 轮换某项目的密钥(应急:泄露后使用) */
async function rotateClient(name) {
  if (!name) throw new Error('用法: node examples/client.js rotate-client <项目名>');
  const data = await api(`/api/clients/${encodeURIComponent(name)}/rotate`, { method: 'POST' });
  console.log(`\n════════════════════════════════════════`);
  console.log(`  项目 ${name} 的新密钥: ${data.key}`);
  console.log(`  旧密钥已立即失效`);
  console.log(`════════════════════════════════════════`);
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
  clients,
  'create-client': () => createClient(arg1, arg2),
  'disable-client': () => disableClient(arg1),
  'rotate-client': () => rotateClient(arg1),
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
  health                        健康检查(无需密钥)
  accounts                      列出所有账号              [需 API_KEY]
  add-account                   新增/更新账号             [需 API_KEY]
  check-token                   验证 AppSecret 并查看 token 状态 [需 API_KEY]
  warmup                        批量预热所有账号 token    [需 API_KEY]
  mini-login <code>             小程序 code 换 openid     [需 API_KEY]
  send-text <openid> <内容>      发送客服消息              [需 API_KEY]
  user <openid>                 获取用户信息              [需 API_KEY]
  clients                       列出密钥(项目)列表        [需 ADMIN_KEY]
  create-client <名> <appids>    为项目签发密钥,明文仅显示一次 [需 ADMIN_KEY]
  disable-client <名>           吊销某项目密钥            [需 ADMIN_KEY]
  rotate-client <名>            轮换某项目密钥(应急)      [需 ADMIN_KEY]
  all                           完整巡检流程              [需 API_KEY]

环境变量:
  BASE_URL     服务地址(默认 http://127.0.0.1:3000)
  APPID        账号 appid
  API_KEY      业务密钥(X-API-Key),访问业务接口用
  ADMIN_KEY    管理员密钥(X-Admin-Key),管理密钥用
  APP_SECRET   录入账号时用
  WX_TOKEN     录入账号时用(回调 Token)
  AES_KEY      录入账号时用(EncodingAESKey)

示例:
  # 管理员:为项目A签发密钥(明文只显示一次)
  ADMIN_KEY=xxx node examples/client.js create-client 项目A wxAAA1,wxAAA2

  # 项目A:用密钥调用业务接口
  API_KEY=wsk_xxx APPID=wxAAA1 node examples/client.js check-token
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
