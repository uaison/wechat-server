#!/bin/bash
#
# make-key.sh —— 签发(或轮换)业务密钥并保存到受保护的文件
#
# 用法:
#   bash scripts/make-key.sh <应用名> [appid列表] [--rotate]
#
#   appid列表  逗号分隔,默认 * (通配全部)
#              例: wx123abc  /  wx123abc,wx456def  /  *
#   --rotate   强制轮换(默认已存在才轮换)
#
# 示例:
#   bash scripts/make-key.sh wechat-main
#   bash scripts/make-key.sh project-a wxaaa111,wxbbb222
#   bash scripts/make-key.sh wechat-main '*' --rotate
#
# 产物:
#   /home/www/.wsk_<应用名>   内容为明文密钥,权限 600
#   屏幕上只打印长度与前缀,不打印密钥本体
#
# 前置:
#   - 服务已启动(默认 http://127.0.0.1:3000)
#   - .env 中已配置 ADMIN_KEY
#
set -u

# ---------- 参数 ----------
NAME="${1:-}"
APPIDS_ARG="${2:-*}"
FORCE_ROTATE=0
for arg in "$@"; do
  [ "$arg" = "--rotate" ] && FORCE_ROTATE=1
done

if [ -z "$NAME" ] || [ "$NAME" = "--rotate" ]; then
  echo "用法: bash $0 <应用名> [appid列表] [--rotate]"
  echo "例:   bash $0 wechat-main"
  echo "      bash $0 project-a wxaaa111,wxbbb222"
  exit 1
fi

PROJ=$(cd "$(dirname "$0")/.." && pwd)
ENVF=$PROJ/.env
BASE=${BASE_URL:-http://127.0.0.1:3000}
OUT="/home/www/.wsk_${NAME}"

# ---------- 读 ADMIN_KEY ----------
if [ ! -f "$ENVF" ]; then
  echo "✗ 找不到 $ENVF"
  exit 1
fi
ADMIN_KEY=$(grep '^ADMIN_KEY=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//')
if [ -z "$ADMIN_KEY" ]; then
  echo "✗ .env 里 ADMIN_KEY 为空,先执行: node scripts/gen-key.js"
  exit 1
fi
echo "✓ ADMIN_KEY 已读取(长度 ${#ADMIN_KEY})"

# ---------- 组装 allowedAppids JSON 数组 ----------
# 逗号分隔 → ["a","b"];单个 * → ["*"]
JSON_APPIDS=""
if [ "$APPIDS_ARG" = "*" ] || [ -z "$APPIDS_ARG" ]; then
  JSON_APPIDS='["*"]'
else
  IFS=',' read -ra _ids <<< "$APPIDS_ARG"
  for id in "${_ids[@]}"; do
    # 去掉首尾空白
    id=$(printf '%s' "$id" | tr -d '[:space:]')
    [ -z "$id" ] && continue
    # 仅允许 appid 安全字符,防注入
    case "$id" in
      *\"*|*\\*|*\'*|*' '*)
        echo "✗ appid 含非法字符: $id"
        exit 1
        ;;
    esac
    if [ -z "$JSON_APPIDS" ]; then
      JSON_APPIDS="\"$id\""
    else
      JSON_APPIDS="$JSON_APPIDS,\"$id\""
    fi
  done
  JSON_APPIDS="[$JSON_APPIDS]"
fi
echo "✓ 应用名: $NAME"
echo "✓ 授权 appid: $JSON_APPIDS"

# ---------- 服务存活 ----------
HEALTH=$(curl -s -m 5 "$BASE/api/health" 2>/dev/null || true)
case "$HEALTH" in
  *'"status":"ok"'*) echo "✓ 服务存活" ;;
  *) echo "✗ 服务无响应($BASE): $HEALTH"; exit 1 ;;
esac

# ---------- 创建或轮换 ----------
RESP=""
if [ "$FORCE_ROTATE" -eq 0 ]; then
  RESP=$(curl -s -m 10 -X POST "$BASE/api/clients" \
    -H "X-Admin-Key: $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$NAME\",\"allowedAppids\":$JSON_APPIDS}")
fi

case "$RESP" in
  *'"key":"'*) : ;;
  *)
    # 已存在 / 强制轮换 → 走 rotate
    echo "… 创建未返回密钥,改为轮换(已存在则这是正常路径)"
    RESP=$(curl -s -m 10 -X POST "$BASE/api/clients/$NAME/rotate" \
      -H "X-Admin-Key: $ADMIN_KEY")
    ;;
esac

KEY=$(printf '%s' "$RESP" | grep -o '"key":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$KEY" ]; then
  echo "✗ 未取到密钥,接口返回:"
  echo "$RESP"
  echo
  echo "提示:项目名含中文/特殊字符时 URL 需转义;ADMIN_KEY 不正确会返回 503"
  exit 1
fi

# ---------- 落盘 ----------
printf '%s' "$KEY" > "$OUT" || { echo "✗ 写入 $OUT 失败(检查属主)"; exit 1; }
chmod 600 "$OUT"

echo
echo "✓ 密钥已保存: $OUT"
echo "  长度: $(wc -c < "$OUT" | tr -d ' ') (应为 68)"
echo "  前缀: $(cut -c1-12 "$OUT")"
echo
echo "验证:"
echo "  curl $BASE/api/accounts -H \"X-API-Key: \$(cat $OUT)\""
echo
echo "若需调整授权范围:"
echo "  curl -X PATCH $BASE/api/clients/$NAME -H \"X-Admin-Key: \$ADMIN_KEY\" \\"
echo "    -H 'Content-Type: application/json' -d '{\"allowedAppids\":$JSON_APPIDS}'"
