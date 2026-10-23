# 部署与调用实战指南

本文档按**实际操作顺序**编写，从一台空白服务器到微信后台配置完成。
如果只想查接口参数，请直接看 [API.md](./API.md)。

---

## 目录

- [第 0 步：前置准备](#第-0-步前置准备)
- [第 1 步：部署代码](#第-1-步部署代码)
- [第 2 步：安装 MySQL 并建库](#第-2-步安装-mysql-并建库)
- [第 3 步：配置环境变量](#第-3-步配置环境变量)
- [第 4 步：执行数据库迁移](#第-4-步执行数据库迁移)
- [第 5 步：本地启动验证](#第-5-步本地启动验证)
- [第 6 步：用 pm2 守护进程](#第-6-步用-pm2-守护进程)
- [第 7 步：配置 Nginx + HTTPS](#第-7-步配置-nginx--https)
- [第 8 步：录入微信账号配置](#第-8-步录入微信账号配置)
- [第 9 步：微信后台配置服务器地址](#第-9-步微信后台配置服务器地址)
- [第 10 步：验证整条链路](#第-10-步验证整条链路)
- [日常运维](#日常运维)
- [故障排查手册](#故障排查手册)

---

## 第 0 步：前置准备

### 需要的东西

| 项 | 说明 |
|---|---|
| 腾讯云服务器 | 1核2G 起步够用，系统建议 Ubuntu 22.04 / CentOS 7+ |
| 已备案域名 | 微信要求服务器地址必须是 **HTTPS + 已备案域名**，不能用 IP |
| SSL 证书 | 腾讯云可免费申请，或用 Let's Encrypt |
| Node.js | ≥ 18，推荐 22 LTS |
| MySQL | 5.7+ 或 8.0 |
| 公众号/小程序 | 已有 AppID 与 AppSecret，且具备开发权限 |

### 开放端口

云服务器**安全组**需要放行：

| 端口 | 用途 | 是否必须 |
|---|---|---|
| 22 | SSH | 是 |
| 80 | HTTP（用于证书续签与跳转） | 是 |
| 443 | HTTPS（微信要求） | 是 |
| 3306 | MySQL | **否，切勿对公网开放** |

> ⚠️ **MySQL 千万不要开公网**。本服务和数据库在同一台机器，走 `127.0.0.1` 即可。

### 安装 Node.js

```bash
# 用 nvm 安装（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
node -v   # 应输出 v22.x.x
```

---

## 第 1 步：部署代码

```bash
mkdir -p /www && cd /www
git clone https://github.com/uaison/wechat-server.git
cd wechat-server
npm i -g pnpm          # 仅需一次
pnpm install --prod
```

> ⚠️ 本项目使用 **pnpm**，仓库只跟踪 `pnpm-lock.yaml`。
> 不要用 `npm install`，否则会生成 `package-lock.json`，两套锁文件会互相打架。

> 若服务器拉取 GitHub 缓慢，可在本地打包上传：
> ```bash
> # 本地
> tar --exclude=node_modules --exclude=.git -czf wechat-server.tar.gz .
> scp wechat-server.tar.gz root@你的服务器IP:/www/
> # 服务器
> cd /www && tar -xzf wechat-server.tar.gz -C wechat-server
> ```

---

## 第 2 步：安装 MySQL 并建库

### Ubuntu

```bash
sudo apt update
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
```

### CentOS

```bash
sudo yum install -y mysql-server
sudo systemctl enable --now mysqld
```

### 建库与创建专用账号

```bash
sudo mysql -u root
```

```sql
-- 1. 建库（必须 utf8mb4，否则微信昵称里的 emoji 会存不进去）
CREATE DATABASE wechat_server
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

-- 2. 创建专用账号（不要用 root 跑业务）
CREATE USER 'wechat'@'127.0.0.1' IDENTIFIED BY '换成你的强密码';

-- 3. 授权（只给这个库的权限）
GRANT ALL PRIVILEGES ON wechat_server.* TO 'wechat'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

**验证连接**：

```bash
mysql -u wechat -p -h 127.0.0.1 -D wechat_server -e "SELECT 1;"
```

---

## 第 3 步：配置环境变量

### 3.1 生成加密密钥

```bash
npm run keygen
```

输出示例：

```
ENCRYPT_KEY=<把 npm run keygen 输出的值填在这里,64 位十六进制>
```

> ⚠️ **这个密钥是数据安全的命门**：
> - 它用于加密库里的 `AppSecret`、`EncodingAESKey`、`access_token`
> - **一旦丢失，已加密的数据永久无法解密**，只能删掉重新录入
> - 请立刻复制到密码管理器里备份，并且**不要**提交到 git

### 3.2 创建 .env

```bash
cp .env.example .env
vim .env
```

**生产环境完整配置示例**：

```ini
# ===== 服务 =====
NODE_ENV=production
PORT=3000
BASE_URL=https://wechat.yourdomain.com
LOG_LEVEL=info

# ===== MySQL =====
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=wechat
DB_PASSWORD=你在第2步设置的密码
DB_NAME=wechat_server
DB_POOL_MIN=2
DB_POOL_MAX=10

# ===== 加密密钥（第3.1步生成的）=====
ENCRYPT_KEY=<把 npm run keygen 输出的值填在这里,64 位十六进制>

# ===== 管理员密钥（保护密钥管理接口,只给运维,不给项目方）=====
ADMIN_KEY=<再生成一个,必须与 ENCRYPT_KEY 不同>

# ===== 微信接口 =====
WECHAT_REQUEST_TIMEOUT=10000
TOKEN_REFRESH_MARGIN_MS=300000
```

> 💡 `ADMIN_KEY` 可再跑一次 `npm run keygen`,复制输出 `=` 后面的部分。

### 3.3 收紧文件权限

```bash
chmod 600 .env
```

---

## 第 4 步：执行数据库迁移

```bash
npm run migrate
```

预期输出：

```
Batch 1 run: 1 migrations
```

**验证表已创建**：

```bash
mysql -u wechat -p -h 127.0.0.1 -D wechat_server -e "SHOW TABLES;"
```

应看到三张表：

```
+--------------------------+
| Tables_in_wechat_server  |
+--------------------------+
| access_tokens            |
| knex_migrations          |
| wechat_accounts          |
+--------------------------+
```

---

## 第 5 步：本地启动验证

```bash
npm start
```

预期日志：

```
[2026-10-16 11:00:00] INFO: 数据库连接成功
[2026-10-16 11:00:00] INFO: 服务已启动: https://wechat.yourdomain.com
[2026-10-16 11:00:00] INFO: 回调地址格式: https://wechat.yourdomain.com/wechat/callback/{appid}
[2026-10-16 11:00:00] INFO: 定时任务已启动: 每 10 分钟巡检 token
[2026-10-16 11:00:00] INFO: access_token 预热完成
```

**另开一个终端测试**：

```bash
curl http://127.0.0.1:3000/api/health
```

```json
{
  "status": "ok",
  "env": "production",
  "time": "2026-10-16T03:00:00.000Z",
  "uptime": 5
}
```

看到 `status: ok` 说明服务正常。按 `Ctrl+C` 停止，进入下一步。

> 💡 **此时若报错**，请看文末 [故障排查手册](#故障排查手册)。

---

## 第 6 步：用 pm2 守护进程

直接用 `npm start` 的问题是：SSH 断开进程就没了，崩溃了也不会自动拉起。用 pm2 解决。

```bash
npm install -g pm2

# 启动（注意用 ecosystem 配置更规范）
pm2 start src/app.js --name wechat-server

# 查看状态
pm2 status

# 查看实时日志
pm2 logs wechat-server

# 设置开机自启
pm2 startup
pm2 save
```

### 推荐用配置文件管理

创建 `ecosystem.config.cjs`：

```js
module.exports = {
  apps: [{
    name: 'wechat-server',
    script: 'src/app.js',
    instances: 1,              // ★ 必须是 1，见下方说明
    exec_mode: 'fork',
    max_memory_restart: '500M', // 内存超限自动重启
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    merge_logs: true,
    time: true,
  }],
};
```

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
```

> ⚠️ **为什么 `instances` 必须是 1？**
> 本服务的 access_token 依赖进程内缓存与并发合并逻辑。若开启 cluster 多实例，
> 每个实例会各自刷新 token。虽然 `stable_token` 有共存窗口不至于互相踢掉，
> 但会造成重复刷新、浪费配额。**单机单实例是当前设计的预期形态**。
> 若日后确实需要多实例，必须引入 Redis 做分布式锁，届时告诉我，我帮你改造。

---

## 第 7 步：配置 Nginx + HTTPS

微信要求服务器地址必须是 HTTPS。用 Nginx 做反向代理。

### 7.1 申请证书

腾讯云控制台 → SSL 证书 → 申请免费证书 → 下载 Nginx 版，上传到服务器：

```
/etc/nginx/ssl/wechat.yourdomain.com.crt
/etc/nginx/ssl/wechat.yourdomain.com.key
```

或用 certbot 自动签发：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wechat.yourdomain.com
```

### 7.2 Nginx 配置

`/etc/nginx/conf.d/wechat-server.conf`：

```nginx
server {
    listen 80;
    server_name wechat.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name wechat.yourdomain.com;

    ssl_certificate     /etc/nginx/ssl/wechat.yourdomain.com.crt;
    ssl_certificate_key /etc/nginx/ssl/wechat.yourdomain.com.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 微信推送的报文可能较大（图片消息），放宽限制
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ★ 微信要求 5 秒内响应，不要让 Nginx 提前断掉
        proxy_read_timeout 15s;
        proxy_connect_timeout 5s;
    }
}
```

### 7.3 重载并验证

```bash
sudo nginx -t          # 语法检查
sudo systemctl reload nginx

curl https://wechat.yourdomain.com/api/health
```

> ⚠️ **两处容易踩坑**：
> 1. **`proxy_set_header Host $host`** 必须保留，否则某些校验会失败
> 2. **不要加 `proxy_buffering off` 之外的重写规则**，尤其不要用 `rewrite` 改 URL——
>    微信签名不包含 URL，但回调路径里的 `appid` 必须原样透传

---

## 第 8 步：录入微信账号配置

> 前置动作:各项目调用 `/api/*` 需要业务密钥。首次部署先签发一个:

```bash
# 用 ADMIN_KEY 为你的管理工具/第一个项目签发密钥(明文只显示一次!)
curl -X POST https://wechat.yourdomain.com/api/clients \
  -H 'X-Admin-Key: 你的ADMIN_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name": "管理工具", "allowedAppids": ["*"]}'
# 返回的 key 即业务密钥,后续调用带上: -H 'X-API-Key: wsk_...'

# 若以后有多个项目接入,为每个项目单独签发并限定其 appid:
# curl -X POST .../api/clients -d '{"name": "项目A", "allowedAppids": ["wxAAA1"]}'
# 项目A 泄露/下线时吊销,不影响其他项目
```

现在服务已经能通过公网访问了。接下来把你的公众号/小程序配置写进数据库。

### 8.1 从微信后台获取四项信息

| 参数 | 从哪拿 |
|---|---|
| AppID | 公众平台 → 开发 → 基本配置 |
| AppSecret | 同上（点"重置"可查看） |
| Token | **你自己设定**的任意字符串，稍后要填回微信后台 |
| EncodingAESKey | 公众平台 → 开发 → 基本配置 → 消息加解密方式（点随机生成） |

### 8.2 调用接口录入

```bash
curl -X POST https://wechat.yourdomain.com/api/accounts  \
  -H 'X-API-Key: wsk_你的业务密钥'\
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wx1234567890abcdef",
    "appSecret": "你的AppSecret",
    "type": "official",
    "name": "我的公众号",
    "token": "myToken123",
    "aesKey": "你的43位EncodingAESKey",
    "remark": "生产环境主号"
  }'
```

成功返回：

```json
{ "code": 0, "message": "保存成功", "data": { "appid": "wx1234567890abcdef" } }
```

### 8.3 验证配置已加密入库

```bash
# 查看账号列表（敏感字段已脱敏）
curl https://wechat.yourdomain.com/api/accounts \
  -H 'X-API-Key: wsk_你的业务密钥'
```

```json
{
  "code": 0,
  "data": [{
    "appid": "wx1234567890abcdef",
    "type": "official",
    "name": "我的公众号",
    "enabled": true,
    "remark": "生产环境主号",
    "hasToken": true,
    "hasAesKey": true
  }]
}
```

注意 `hasToken` / `hasAesKey` 为 `true` 表示已配置。**接口不会返回明文**，这是有意设计。

确认库里存的是密文：

```bash
mysql -u wechat -p -h 127.0.0.1 -D wechat_server \
  -e "SELECT appid, LEFT(app_secret, 30) AS secret_cipher FROM wechat_accounts;"
```

应看到 `v1:xxxx:xxxx:xxxx` 格式的密文，而**不是**你的真实 AppSecret。

### 8.4 立刻验证 AppSecret 是否正确

这一步很关键——趁早发现填错。

```bash
curl -X POST https://wechat.yourdomain.com/api/token/wx1234567890abcdef/refresh \
  -H 'X-API-Key: wsk_你的业务密钥'
```

**成功**：

```json
{ "code": 0, "message": "刷新成功", "data": { "appid": "wx1234567890abcdef", "length": 107 } }
```

**失败**（AppSecret 填错）：

```json
{ "code": 40013, "message": "invalid appid", "detail": "上游微信接口返回错误" }
```

看到 `40013` 就回到 8.2 重新录入正确的 AppSecret。

---

## 第 9 步：微信后台配置服务器地址

### 9.1 填写配置

登录微信公众平台 → 开发 → 基本配置 → 服务器配置 → 修改配置：

| 项 | 填写内容 |
|---|---|
| URL | `https://wechat.yourdomain.com/wechat/callback/wx1234567890abcdef` |
| Token | 与第 8.2 步录入的 `token` **完全一致** |
| EncodingAESKey | 与第 8.2 步录入的 `aesKey` **完全一致** |
| 消息加解密方式 | 建议选**安全模式**（推荐）或明文模式 |
| 数据格式 | XML |

⚠️ **URL 末尾的 appid 是必填的**，这是本服务识别"消息属于哪个号"的依据。

### 9.2 点"提交"

微信会立即向你的 URL 发一个 **GET** 请求做校验。此时：

- **成功** → 页面提示"提交成功"，数据库日志出现 `回调 URL 校验通过`
- **失败** → 提示"配置失败"，按提示的错误类型排查

**实时观察日志确认**：

```bash
pm2 logs wechat-server --lines 20
```

应出现：

```
INFO: 回调 URL 校验通过
```

### 9.3 启用配置

提交成功后，记得点**"启用"**。未启用的话消息不会推送到你的服务器。

---

## 第 10 步：验证整条链路

### 10.1 主动调用链路：发一条客服消息

先拿一个测试用户的 openid（可以在后台用户管理里看到，或让用户先关注后用 `/api/user` 接口查）。

```bash
curl -X POST https://wechat.yourdomain.com/api/message/custom/send  \
  -H 'X-API-Key: wsk_你的业务密钥'\
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wx1234567890abcdef",
    "message": {
      "touser": "用户的openid",
      "msgtype": "text",
      "text": { "content": "这是来自 wechat-server 的测试消息" }
    }
  }'
```

成功返回：

```json
{ "code": 0, "data": { "errcode": 0, "errmsg": "ok" } }
```

用户微信上应收到消息。**这一步通了，说明 token 管理 + 主动调用全链路正常。**

### 10.2 被动接收链路：让用户发条消息

用微信给公众号发一条"你好"，然后看日志：

```bash
pm2 logs wechat-server --lines 30
```

应看到：

```
DEBUG: 收到未处理消息
    appid: "wx1234567890abcdef"
    msgType: "text"
    from: "o_xxxxx"
```

### 10.3 检查 token 状态

```bash
curl https://wechat.yourdomain.com/api/token/wx1234567890abcdef/status \
  -H 'X-API-Key: wsk_你的业务密钥'
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

`valid: true` 表示 token 可用。`remainingSeconds` 小于 300 时下次调用会自动刷新。

---

## 日常运维

### 查看日志

```bash
pm2 logs wechat-server           # 实时
pm2 logs wechat-server --lines 100  # 最近 100 行
```

### 重启 / 停止

```bash
pm2 restart wechat-server
pm2 stop wechat-server
pm2 delete wechat-server
```

### 新增一个公众号

只需调一次接口，**不用改代码、不用重启**：

```bash
curl -X POST https://wechat.yourdomain.com/api/accounts  \
  -H 'X-API-Key: wsk_你的业务密钥'\
  -H 'Content-Type: application/json' \
  -d '{
    "appid": "wx新号的appid",
    "appSecret": "新号的AppSecret",
    "type": "official",
    "name": "第二个公众号",
    "token": "newToken456",
    "aesKey": "新号的EncodingAESKey"
  }'
```

然后去微信后台配对应号的服务器地址：`/wechat/callback/wx新号的appid`。

新号会在下一次定时巡检（最多 10 分钟）时自动预热 token，也可立刻手动触发：

```bash
curl -X POST https://wechat.yourdomain.com/api/token/warmup \
  -H 'X-API-Key: wsk_你的业务密钥'
```

### 备份

**必须备份两样**：

```bash
# 1. 数据库
mysqldump -u wechat -p wechat_server > /backup/wechat_server_$(date +%F).sql

# 2. .env（尤其是 ENCRYPT_KEY！）
cp .env /backup/env_$(date +%F).bak
chmod 600 /backup/env_*.bak
```

> ⚠️ 数据库备份 + `.env` 里的 `ENCRYPT_KEY` 必须**配对保存**。
> 只有数据库没有密钥 → 解不开密文；只有密钥没有数据库 → 没有数据。

### 更新代码

```bash
cd /www/wechat-server
git pull
pnpm install --prod
npm run migrate      # 若有新的迁移脚本
pm2 restart wechat-server
```

---

## 故障排查手册

### 微信后台提示"配置失败"

| 排查项 | 检查方法 |
|---|---|
| URL 是否正确 | 必须是 `https://域名/wechat/callback/{appid}`，appid 不能漏 |
| Token 是否一致 | 数据库里的 `token` 必须与微信后台填的**完全相同**（含大小写） |
| 域名是否备案 | 未备案域名微信无法访问 |
| HTTPS 证书是否有效 | 浏览器访问域名不应有证书警告 |
| 服务是否在跑 | `pm2 status` 看状态 |
| 日志有无线索 | `pm2 logs` 看是否出现"签名不通过"或"账号未配置" |

### 日志报"账号未配置"

回调 URL 里的 appid 与数据库里的对不上。核对：

```bash
curl https://wechat.yourdomain.com/api/accounts | grep appid \
  -H 'X-API-Key: wsk_你的业务密钥'
```

### 日志报"签名不通过"

Token 不匹配。三种可能：

1. 数据库里的 `token` 与微信后台填的不一致
2. 用了安全模式但 `aesKey` 没填
3. 录入时 Token 前后多了空格

重新录入时注意不要带空格：

```bash
curl -X POST .../api/accounts -d '{"token": "myToken123", ...}'
```

### 报"数据库连接失败"

```bash
# 1. 确认 MySQL 在跑
sudo systemctl status mysql

# 2. 用 .env 里的账号手工连一次
mysql -u wechat -p -h 127.0.0.1 -D wechat_server -e "SELECT 1;"

# 3. 确认 .env 配置正确
cat .env | grep DB_
```

### 报"未配置 ENCRYPT_KEY"

`.env` 里 `ENCRYPT_KEY` 为空，或 `.env` 文件不在项目根目录。

```bash
ls -la .env                       # 确认文件存在
grep ENCRYPT_KEY .env             # 确认有值
```

### 用户反映"收到重复消息"

说明处理超时了（微信 5 秒限制）。检查消息处理器里是否有耗时操作——
本项目默认走"快速返回 success"策略，若你在 `message.service.js` 里注册的处理器
做了重活（查多次库、调外部接口），必须改造为异步处理。

查看是否有超时迹象：

```bash
grep "ms.*[5-9][0-9][0-9][0-9]" logs/out.log   # 找响应超过 5 秒的请求
```

### token 频繁失效

确认用的是 `stable_token` 接口。若库里 token 更新时间异常频繁，可能是：

```bash
# 看刷新频率
mysql -u wechat -p -D wechat_server \
  -e "SELECT appid, refreshed_at, expires_at FROM access_tokens;"
```

正常应约 2 小时刷新一次。若几分钟一次，检查是否有其他地方也在刷新同一个号。

### 想重置某个号的 token

```bash
# 强制刷新
curl -X POST https://wechat.yourdomain.com/api/token/wxXXX/refresh -d '{"force": true}' \
  -H 'X-API-Key: wsk_你的业务密钥'
```

彻底清空（下次调用会重新拉取）：

```bash
mysql -u wechat -p -D wechat_server -e "DELETE FROM access_tokens WHERE appid='wxXXX';"
```

---

## 完整操作清单（打勾用）

```
□ 服务器安全组放行 22 / 80 / 443
□ 安装 Node.js 22
□ 部署代码并 pnpm install --prod
□ 安装 MySQL，建库 wechat_server（utf8mb4）
□ 创建专用数据库账号 wechat
□ npm run keygen 生成密钥，并备份到密码管理器
□ 配置 .env（NODE_ENV=production、DB_*、ENCRYPT_KEY）
□ chmod 600 .env
□ npm run migrate 建表
□ npm start 验证能起来，/api/health 返回 ok
□ pm2 守护进程，设置开机自启（instances=1）
□ 申请 SSL 证书
□ 配置 Nginx 反代（保留 Host 头）
□ 微信后台获取 AppID / AppSecret / 生成 EncodingAESKey
□ POST /api/accounts 录入配置
□ POST /api/token/{appid}/refresh 验证 AppSecret 正确
□ 微信后台填服务器地址 URL + Token + AESKey，提交并启用
□ 发客服消息验证主动调用链路
□ 用户发消息验证被动接收链路
□ 配置数据库与 .env 的定期备份
```
