# API 调用文档

本文档是**接口参考**。要了解怎么部署上线，请先看 [DEPLOYMENT.md](./DEPLOYMENT.md)。

**基础地址**：`https://wechat.yourdomain.com`（下文示例统一用 `$BASE` 代指）

```bash
export BASE=https://wechat.yourdomain.com
```

---

## 通用约定

### 响应格式

**成功**：

```json
{ "code": 0, "data": { ... } }
```

**失败**：

```json
{ "code": 40013, "message": "invalid appid", "detail": "上游微信接口返回错误" }
```

| 字段 | 说明 |
|---|---|
| `code` | `0` 表示成功；非 0 为错误码 |
| `message` | 错误描述 |
| `data` | 成功时的数据载荷 |
| `detail` | 附加说明（可选） |

### 错误码分类

| 码段 | 含义 | 处理建议 |
|---|---|---|
| `0` | 成功 | — |
| `400` / `404` / `401` | 本服务的参数或鉴权问题 | 检查请求参数 |
| `5xx`（含微信原始码如 `40013`） | 微信上游返回错误 | 按微信文档排查 |

**注意**：微信的业务错误码会被**原样透传**（如 `40013`、`40001`），
方便你对照[微信官方错误码文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Global_Return_Code.html)定位问题。

### 通用错误码

| code | HTTP | 含义 | 解决办法 |
|---|---|---|---|
| `400` | 400 | 参数缺失或格式错误 | 看 `message` 字段 |
| `404` | 404 | 资源不存在（如账号未配置） | 先调 `/api/accounts` 录入 |
| `502` | 502 | 微信接口调用失败 | 看 `code` 里的微信错误码 |
| `500` | 500 | 服务内部错误 | 查服务日志 |

---

## 目录

- [健康检查](#健康检查)
- [账号管理](#账号管理)
- [access_token 管理](#access_token-管理)
- [业务接口](#业务接口)
- [微信回调接口](#微信回调接口)
- [调用代码示例](#调用代码示例)

---

## 健康检查

### GET /api/health

用于监控探活、负载均衡健康检查。无需参数。

```bash
curl $BASE/api/health
```

```json
{
  "status": "ok",
  "env": "production",
  "time": "2026-10-16T03:00:00.000Z",
  "uptime": 3600
}
```

> 💡 部署后第一件事就该调这个接口。看到 `status: ok` 说明服务和数据库都正常。

---

## 账号管理

### POST /api/accounts —— 新增或更新账号

这是**最常用的接口**。新增公众号/小程序时调它，已存在的 appid 会更新配置。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `appid` | string | ✅ | 微信 AppID |
| `appSecret` | string | ✅ | 微信 AppSecret |
| `type` | string | — | `official`（公众号，默认）/ `mini`（小程序） |
| `name` | string | — | 备注名称，便于人眼识别 |
| `token` | string | — | 消息推送校验 Token（公众号必填） |
| `aesKey` | string | — | 43 位 EncodingAESKey（安全模式必填） |
| `enabled` | boolean | — | 是否启用，默认 `true` |
| `remark` | string | — | 其他备注 |

**示例：录入公众号**

```bash
curl -X POST $BASE/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wx1234567890abcdef",
    "appSecret": "b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "type": "official",
    "name": "我的公众号",
    "token": "myToken123",
    "aesKey": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    "remark": "生产环境主号"
  }'
```

**示例：录入小程序**

小程序没有消息推送，不需要 `token` 和 `aesKey`：

```bash
curl -X POST $BASE/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wxabcdef1234567890",
    "appSecret": "你的小程序AppSecret",
    "type": "mini",
    "name": "我的小程序"
  }'
```

**响应**：

```json
{ "code": 0, "message": "保存成功", "data": { "appid": "wx1234567890abcdef" } }
```

> ⚠️ **录入后建议立刻验证 AppSecret**：
> ```bash
> curl -X POST $BASE/api/token/wx1234567890abcdef/refresh
> ```
> 返回 `40013` 说明 AppSecret 填错了。

### GET /api/accounts —— 账号列表

敏感字段会**脱敏**，只返回是否已配置。

```bash
curl $BASE/api/accounts
```

```json
{
  "code": 0,
  "data": [
    {
      "appid": "wx1234567890abcdef",
      "type": "official",
      "name": "我的公众号",
      "enabled": true,
      "remark": "生产环境主号",
      "hasToken": true,
      "hasAesKey": true,
      "createdAt": "2026-10-16 11:00:00"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `hasToken` | 是否配置了 Token（公众号需要） |
| `hasAesKey` | 是否配置了 EncodingAESKey（安全模式需要） |

> 💡 这两个字段为 `false` 时，回调验签会失败。**排查回调问题时先看这两个值。**

### POST /api/accounts/:appid/disable —— 停用账号

停用后：不再刷新该号 token，回调也不再处理。数据保留。

```bash
curl -X POST $BASE/api/accounts/wx1234567890abcdef/disable
```

```json
{ "code": 0, "message": "已停用" }
```

> 💡 这是**软删除**。要彻底删除需要手工执行 SQL，这是有意设计——避免误删配置。

---

## access_token 管理

> 🔑 本服务的核心价值就在这里。**业务代码不需要自己管 token**，
> 直接调业务接口即可，token 会自动获取、复用、刷新、重试。

### GET /api/token/:appid/status —— 查询 token 状态

**不会返回 token 明文**（安全考虑），只返回状态信息。

```bash
curl $BASE/api/token/wx1234567890abcdef/status
```

```json
{
  "code": 0,
  "data": {
    "appid": "wx1234567890abcdef",
    "cached": true,
    "expiresAt": "2026-10-16 13:00:00",
    "refreshedAt": "2026-10-16 11:00:00",
    "remainingSeconds": 7130,
    "valid": true
  }
}
```

| 字段 | 说明 |
|---|---|
| `cached` | 库里是否有缓存（`false` 表示还没获取过） |
| `expiresAt` | 绝对过期时间 |
| `refreshedAt` | 最近刷新时间（正常应约 2 小时一次） |
| `remainingSeconds` | 剩余有效秒数 |
| `valid` | 是否可直接使用（剩余 > 5 分钟才为 `true`） |

未缓存时：

```json
{ "code": 0, "data": { "appid": "wx1234567890abcdef", "cached": false } }
```

### POST /api/token/:appid/refresh —— 强制刷新 token

**请求体**（可选）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `force` | boolean | `true` | 传给微信的 `force_refresh` 参数 |

```bash
# 强制换新的
curl -X POST $BASE/api/token/wx1234567890abcdef/refresh

# 让微信自行判断（可能直接返回现有 token）
curl -X POST $BASE/api/token/wx1234567890abcdef/refresh \
  -H 'Content-Type: application/json' \
  -d '{"force": false}'
```

```json
{ "code": 0, "message": "刷新成功", "data": { "appid": "wx1234567890abcdef", "length": 107 } }
```

> 💡 这个接口有两个用途：
> ① **验证 AppSecret 是否正确**（新录入配置后立刻验一下）
> ② **排查 token 异常**（看看能不能正常换到）

### POST /api/token/warmup —— 批量预热

遍历所有启用账号，确保每个都有可用 token。单个失败不影响其他。

```bash
curl -X POST $BASE/api/token/warmup
```

```json
{
  "code": 0,
  "data": {
    "ok": ["wx1234567890abcdef", "wxabcdef1234567890"],
    "failed": [
      { "appid": "wxBadSecret000", "error": "微信接口错误 40013: invalid appid" }
    ]
  }
}
```

> 💡 **新增账号后调这个**，可以立即给新号预热 token，不用等 10 分钟的定时巡检。

---

## 业务接口

### POST /api/mini/session —— 小程序登录

用 `wx.login()` 拿到的 `code` 换 `openid` 和 `session_key`。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `appid` | string | ✅ | 小程序 AppID |
| `code` | string | ✅ | `wx.login()` 返回的 code |

```bash
curl -X POST $BASE/api/mini/session \
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wxabcdef1234567890",
    "code": "081Kd5Ga1aBqQK0x2eHa1vXyZq0Kd5Gb"
  }'
```

```json
{
  "code": 0,
  "data": {
    "openid": "o_xxxxxxxxxxxxxxxxxx",
    "session_key": "xxxxxxxxxxxxxxx==",
    "unionid": "u_xxxxxxxxxxx"
  }
}
```

> ⚠️ **`session_key` 是敏感数据，绝不能返回给前端！**
> 本接口是**给后端调用的**。正确做法：你的后端调这个接口，
> 自己保存 `session_key`（用于解密用户数据），只把 `openid` 或自定义登录态返回给前端。

**code 失效错误**：

```json
{ "code": 40163, "message": "code been used", "detail": "上游微信接口返回错误" }
```

`40163` 的常见原因：同一个 code 用了两次。code 只能使用一次。

### POST /api/message/custom/send —— 发送客服消息

⚠️ **前提条件**：用户必须在 **48 小时内**与公众号有过交互，否则微信会拒绝（错误码 `45015`）。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `appid` | string | ✅ | 公众号 AppID |
| `message` | object | ✅ | 微信客服消息格式，见下 |

**发文本**：

```bash
curl -X POST $BASE/api/message/custom/send \
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wx1234567890abcdef",
    "message": {
      "touser": "o_xxxxxxxxxxxxxxxxxx",
      "msgtype": "text",
      "text": { "content": "你好，这是一条客服消息" }
    }
  }'
```

```json
{ "code": 0, "data": { "errcode": 0, "errmsg": "ok" } }
```

**发图文/图片/卡片**，`message` 换成对应结构即可：

```json
{
  "touser": "o_xxx",
  "msgtype": "image",
  "image": { "media_id": "MEDIA_ID" }
}
```

```json
{
  "touser": "o_xxx",
  "msgtype": "news",
  "news": {
    "articles": [{
      "title": "标题",
      "description": "描述",
      "url": "https://your.site/page",
      "picurl": "https://your.site/pic.jpg"
    }]
  }
}
```

> 💡 这里**不需要传 `access_token`** ——服务内部自动管理。
> 这就是本服务存在的意义：调用者只管业务。

### GET /api/user/:appid/:openid —— 获取用户信息

```bash
curl $BASE/api/user/wx1234567890abcdef/o_xxxxxxxxxxxxxxxxxx
```

```json
{
  "code": 0,
  "data": {
    "subscribe": 1,
    "openid": "o_xxxxxxxxxxxxxxxxxx",
    "nickname": "张三",
    "sex": 1,
    "city": "深圳",
    "headimgurl": "https://thirdwx.qlogo.cn/...",
    "subscribe_time": 1700000000
  }
}
```

| 字段 | 说明 |
|---|---|
| `subscribe` | `1` 已关注，`0` 未关注 |
| `nickname` | 昵称（中文与 emoji 已用 utf8mb4 存储） |

---

## 微信回调接口

### GET /wechat/callback/:appid —— 服务器地址校验

**这个接口不是你调用的**，是微信后台配置服务器地址时自动发起的校验握手。

微信发来 `signature` / `timestamp` / `nonce` / `echostr`，
服务验签通过后**原样返回 `echostr`**，微信即认为配置成功。

### POST /wechat/callback/:appid —— 接收消息推送

**同样不是你调用的**，是用户发消息时微信推送过来的。

- 明文模式：直接验签
- 安全模式：验签 → 解密 → 处理 → 加密回复

**重要特性**：

| 特性 | 说明 |
|---|---|
| 5 秒超时 | 微信要求 5 秒内响应，否则重试推送（用户会收到重复消息） |
| 必须返回 success | 无回复时返回字符串 `success`，微信就不再重试 |
| 失败不抛 5xx | 本服务即使内部出错也返回 `success`，避免微信疯狂重试 |

**如何扩展消息处理**：编辑 `src/services/message.service.js`，用注册表模式：

```js
import { register, buildTextReply } from './services/message.service.js';

// 处理文本消息
register('text', async (msg, ctx) => {
  console.log(`收到来自 ${msg.fromUserName} 的文本：${msg.content}`);

  // ⚠️ 这里不要做耗时操作！超过 5 秒微信会重试
  return buildTextReply({
    toUser: msg.fromUserName,
    fromUser: msg.toUserName,
    content: `你说了：${msg.content}`,
  });
});

// 处理图片消息
register('image', async (msg, ctx) => {
  console.log(`收到图片，mediaId=${msg.mediaId}`);
  return null; // 返回 null 表示不回复
});
```

**可用的注册键**：

| 键 | 触发条件 |
|---|---|
| `text` | 文本消息 |
| `image` | 图片消息 |
| `voice` | 语音消息 |
| `video` | 视频消息 |
| `location` | 位置消息 |
| `link` | 链接消息 |
| `event.subscribe` | 关注事件 |
| `event.unsubscribe` | 取关事件 |
| `event.CLICK` | 菜单点击 |
| `event.SCAN` | 扫码 |
| `*` | 兜底（未匹配时） |

---

## 调用代码示例

### Node.js（服务端调用）

```js
const BASE = 'https://wechat.yourdomain.com';

/**
 * 统一请求封装
 */
async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`接口错误 ${data.code}: ${data.message}`);
  }
  return data.data;
}

// ---- 小程序登录 ----
async function miniLogin(code) {
  const data = await api('/api/mini/session', {
    method: 'POST',
    body: JSON.stringify({
      appid: 'wxabcdef1234567890',
      code,
    }),
  });

  // ★ 安全提醒：session_key 必须留在服务端，不要返回给前端！
  await saveSessionKey(data.openid, data.session_key);
  return { openid: data.openid };
}

// ---- 发送客服消息 ----
async function sendText(openid, content) {
  return api('/api/message/custom/send', {
    method: 'POST',
    body: JSON.stringify({
      appid: 'wx1234567890abcdef',
      message: {
        touser: openid,
        msgtype: 'text',
        text: { content },
      },
    }),
  });
}

// ---- 获取用户信息 ----
async function getUser(openid) {
  return api(`/api/user/wx1234567890abcdef/${openid}`);
}

// 使用
const r = await sendText('o_xxxxxxxxxx', '你好');
console.log(r); // { errcode: 0, errmsg: 'ok' }
```

### 前端调用（通过你自己的后端转发）

> ⚠️ **前端绝对不能直接调用本服务** —— 它没有鉴权，且会暴露 AppSecret 相关能力。
> 正确架构是：前端 → 你的业务后端（有登录鉴权）→ wechat-server。

```js
// 前端代码
async function login(code) {
  // 调你自己的后端，不是 wechat-server
  const res = await fetch('/your-api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { token, openid } = await res.json();

  localStorage.setItem('token', token);
  return openid;
}
```

### Shell 脚本（运维用）

```bash
#!/bin/bash
# check-wechat.sh —— 健康巡检脚本

BASE=https://wechat.yourdomain.com
APPID=wx1234567890abcdef

echo "=== 1. 健康检查 ==="
curl -s $BASE/api/health | jq .

echo "=== 2. token 状态 ==="
curl -s $BASE/api/token/$APPID/status | jq '.data | {valid, remainingSeconds}'

echo "=== 3. 账号配置 ==="
curl -s $BASE/api/accounts | jq '.data[] | {appid, name, hasToken, hasAesKey}'
```

```bash
chmod +x check-wechat.sh
./check-wechat.sh
```

---

## 常见错误码速查

### 微信上游错误码（会被透传）

| code | 含义 | 解决办法 |
|---|---|---|
| `40001` | invalid credential | 服务会自动强制刷新 token 重试一次；若持续出现，检查 AppSecret |
| `40013` | invalid appid | **AppSecret 或 AppID 填错了**，重新录入 |
| `40003` | invalid openid | openid 不对，或不是这个号的用户 |
| `40163` | code been used | code 只能用一次，别重复提交 |
| `45015` | response out of time limit | 用户超过 48 小时未交互，无法发客服消息 |
| `45009` | api freq out of limit | 调用频率超限，等一会儿 |
| `48001` | api unauthorized | 该号没有这个接口权限（如未认证的订阅号） |
| `48002` | api forbidden | 接口被禁止调用，检查后台设置 |
| `61004` | access clientip is not registered | 白名单限制，去后台把服务器 IP 加白 |

### 本服务错误码

| code | 含义 | 解决办法 |
|---|---|---|
| `400` | 参数缺失 | 看 `message` |
| `404` | 账号未配置 | 先 `POST /api/accounts` |
| `502` | 微信接口失败 | 看具体微信错误码 |

---

## 自测命令合集

```bash
export BASE=https://wechat.yourdomain.com
export APPID=wx1234567890abcdef

# 1. 服务是否活着
curl -s $BASE/api/health | jq .

# 2. 账号配置是否正确（重点看 hasToken / hasAesKey）
curl -s $BASE/api/accounts | jq .

# 3. AppSecret 是否有效（最关键的一步验证）
curl -s -X POST $BASE/api/token/$APPID/refresh | jq .

# 4. token 状态
curl -s $BASE/api/token/$APPID/status | jq .

# 5. 批量预热
curl -s -X POST $BASE/api/token/warmup | jq .
```
