# wechat-server

独立的微信服务端 API 应用。统一管理多公众号 / 小程序的 `access_token`，处理微信服务器消息推送，并为业务方提供 HTTP 接口。

## 文档导航

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | **部署与上线实战**：从空白服务器到微信后台配置完成的 10 个步骤 | 第一次部署时**按顺序照做** |
| [docs/API.md](docs/API.md) | **接口参考**：所有对外接口的参数、响应、错误码 | 写代码调用时查 |
| [examples/client.js](examples/client.js) | **可运行示例**：8 个命令覆盖全部主要接口 | 想快速验证接口 |
| 本文件 | 架构设计、目录结构、核心机制说明 | 理解项目原理 |

### 快速验证（无需 MySQL）

```bash
# 终端 1：启动演示服务（内存库）
node examples/demo-server.js

# 终端 2：完整巡检
BASE_URL=http://127.0.0.1:3000 node examples/client.js all
```

> 💡 若报 `fetch failed`，是开发机的 `HTTP_PROXY` 把本地请求也转发给代理了，清掉即可：
> `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy BASE_URL=... node examples/client.js all`

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 18（ESM） | 事件循环契合"收消息快速 ACK"模型 |
| Web 框架 | Koa 2 | 中间件可控，便于拿**原始请求体**做验签 |
| 数据库 | MySQL + Knex | 查询构建器 + 迁移，SQL 可控 |
| 定时任务 | node-cron | 单机场景无需外部调度器 |
| 日志 | pino | 结构化、高性能 |
| 加密 | Node 内置 crypto | AES-256-GCM 落库加密；AES-256-CBC 微信消息加解密 |

## 目录结构

```
src/
├── app.js                  # 入口：中间件装配、启动、优雅退出
├── config/index.js         # 配置集中读取与校验
├── db/knex.js              # 数据库连接池
├── middleware/
│   ├── raw-body.js         # ★ 原始请求体捕获（验签依赖，必须最先执行）
│   └── error.js            # 统一错误处理
├── models/                 # 数据访问层（透明加解密）
│   ├── account.model.js
│   └── token.model.js
├── routes/
│   ├── callback.js         # /wechat/callback/:appid 消息推送
│   └── api.js              # /api/* 对外业务接口
├── services/
│   ├── token.service.js    # ★ access_token 统一管理（核心）
│   ├── wechat.service.js   # 微信 API 封装
│   └── message.service.js  # 消息解析与分发
├── scheduler/index.js      # 定时巡检 token
└── utils/
    ├── crypto.js           # AES-256-GCM 字段加解密
    ├── wx-crypto.js        # 微信签名 / 消息加解密
    ├── http.js             # 请求封装（超时、errcode 判定）
    └── logger.js
migrations/                 # 数据库迁移
scripts/                    # 工具脚本（密钥生成、自测）
docs/
├── DEPLOYMENT.md           # 部署与上线实战指南
└── API.md                  # 接口参考文档
examples/
├── client.js               # 可运行的调用示例（8 个命令）
└── demo-server.js          # 本地演示服务（内存库，无需 MySQL）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 生成加密密钥

```bash
npm run keygen
```

把输出的 `ENCRYPT_KEY=...` 写入 `.env`。

> ⚠️ 密钥用于加密 `app_secret` / `aes_key` / `access_token`。**一旦丢失，已加密数据永久无法解密**，请务必备份。密钥只存在于 `.env`（已在 `.gitignore` 中），绝不入库。

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写 MySQL 连接信息
```

### 4. 建库并执行迁移

```sql
CREATE DATABASE wechat_server DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

```bash
npm run migrate
```

### 5. 启动

```bash
npm run dev     # 开发（--watch 自动重启）
npm start       # 生产
```

生产建议用 pm2：

```bash
pm2 start src/app.js --name wechat-server
```

## 公众号 / 小程序接入

### 1. 录入账号配置

```bash
curl -X POST http://localhost:3000/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wx1234567890abcdef",
    "appSecret": "你的AppSecret",
    "type": "official",
    "name": "示例公众号",
    "token": "你在微信后台设置的Token",
    "aesKey": "你的43位EncodingAESKey"
  }'
```

`type` 取值：`official`（公众号）/ `mini`（小程序）。

### 2. 在微信公众平台配置服务器地址

| 项 | 值 |
|---|---|
| URL | `https://你的域名/wechat/callback/{appid}` |
| Token | 与录入的 `token` 一致 |
| EncodingAESKey | 与录入的 `aesKey` 一致 |
| 消息加解密方式 | 明文模式或安全模式均支持 |

> 微信会先发 **GET** 请求做校验握手，验签通过后原样返回 `echostr`。

## access_token 管理机制

这是本项目的核心设计，要点如下：

### 使用 stable 接口

调用 `/cgi-bin/stable_token`（而非 `/cgi-bin/token`）。区别在于：

- **stable 接口**：新旧 token 有**共存窗口**，刷新不会把正在使用的 token 立即踢掉
- **普通接口**：每次调用都会让旧 token 立即失效

因此本服务可以放心按需刷新，无需担心自伤。

### 取 token 流程

```
1. 查库中该 appid 的 token
2. 若存在 且 (expires_at - now) > 5 分钟  →  直接复用
3. 否则 → 调用 stable_token（force_refresh=false）→ 落库 → 返回
```

**为什么留 5 分钟边际？** 从"判断它还有 1 分钟有效"到"真正发出请求"，中间有网络延迟与排队时间。贴着过期时间使用，很可能在传输途中失效。提前刷新是拿极少的 token 请求量，换掉大量的业务失败重试。

### `force_refresh` 策略

| 场景 | 取值 | 原因 |
|---|---|---|
| 常规刷新（到期/临期） | `false` | 让微信自行判断，可能直接返回现有 token，更快更省 |
| 凭据错误兜底 | `true` | 时间没到但已被作废，必须强制换新 |

### 自动重试

业务调用统一通过 `token.service.withToken()` 包装：

```js
import { withToken } from './services/token.service.js';

const data = await withToken(appid, (token) =>
  requestJson('/cgi-bin/user/info', { params: { access_token: token, openid } })
);
```

若收到 `40001 / 40014 / 42001` 等凭据类错误，会自动强制刷新 token 并**重试一次**（仅一次，防止死循环）。

### 定时巡检

`node-cron` 每 10 分钟巡检全部启用账号，临期或失效自动刷新。单账号失败不影响其他账号。

## 对外 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/accounts` | 账号列表（敏感字段脱敏） |
| POST | `/api/accounts` | 新增 / 更新账号 |
| POST | `/api/accounts/:appid/disable` | 停用账号 |
| GET | `/api/token/:appid/status` | 查看 token 状态（不含明文） |
| POST | `/api/token/:appid/refresh` | 强制刷新 token |
| POST | `/api/token/warmup` | 批量预热所有账号 |
| POST | `/api/mini/session` | 小程序 code 换 openid |
| POST | `/api/message/custom/send` | 发送客服消息 |
| GET | `/api/user/:appid/:openid` | 获取用户信息 |

## 数据库表

### `wechat_accounts`

多号配置表，`appid` 为主键。`app_secret` / `token` / `aes_key` 均加密存储。

### `access_tokens`

token 表，`appid` 为主键，天然实现"按号隔离"。token 加密存储。

## 消息处理扩展

采用注册表模式，新增消息类型只需注册处理器：

```js
import { register, buildTextReply } from './services/message.service.js';

register('image', async (msg, ctx) => {
  // msg.mediaId 可取到图片素材 ID
  return buildTextReply({
    toUser: msg.fromUserName,
    fromUser: msg.toUserName,
    content: '已收到图片',
  });
});
```

可用的注册键：`text` / `image` / `event.subscribe` / `event.unsubscribe` / `*`（兜底）。

## 自测

```bash
npm test                # 加密逻辑(22项) + 业务链路集成测试(49项)
npm run test:self       # 仅加密与加解密逻辑
npm run test:integration # 仅业务链路(用内存库,无需 MySQL)
npm run test:smoke      # 路由装配冒烟
```

## 安全注意事项

1. **`.env` 绝不提交**（已在 `.gitignore`）。`ENCRYPT_KEY` 丢失会导致数据不可解密。
2. **回调必须验签**，且签名基于原始请求体，不能使用重新序列化的字符串。
3. **加解密失败要容错**：本项目在校验失败时返回错误、解密失败时降级处理，避免异常放大。
4. **生产环境置于 HTTPS 之后**（Nginx 反代），并开启 `app.proxy = true`（已内置）以取真实 IP。

## 常见问题

**Q：微信回调一直提示"配置失败"？**

按顺序排查：① URL 是否 `https` 且公网可达；② `token` 是否与后台一致；③ 服务日志中是否有"签名不通过"；④ 反代是否把 query string 完整透传。

**Q：收到重复消息？**

微信 5 秒超时后会重试。检查消息处理器中是否有耗时操作——应按"验签 → 快速响应 → 异步处理"原则改造。

**Q：token 频繁失效？**

确认使用的是 `stable_token` 接口。若仍在用普通接口，多号同时刷新会互相踢掉 token。
