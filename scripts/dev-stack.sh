#!/bin/bash
# 热更新开发栈：一次把三件东西起起来
#
#   1) 后端宿主   node --watch-path=src   —— 改后端代码自动重启
#      （不能用 tsx watch：loader 每次启动重写 .cordis/resolve.mjs，会触发无限重启）
#   2) 前端外壳   vite dev                 —— 改外壳代码 HMR；/api 与 /plugins 代理到后端
#   3) 插件前端   vite build --watch       —— 改插件代码自动重出 lib/client.js（刷新页面生效）
#
# 为什么需要这个脚本：本机的对外入口被固定住了（nginx `5180 → 172.x.x.x:5173`），
# 而 vite 的默认已经是 5173（见 apps/web/vite.config.ts），外面才看得到；换端口靠这里传第二个参数。
#
# 用法：
#   scripts/dev-stack.sh [后端端口] [前端端口]
#   scripts/dev-stack.sh 8087 5173
#
# 端口被占时优先换后端端口（前端端口必须与 nginx 的 upstream 一致）：
#   scripts/dev-stack.sh 8100 5173
set -u

CD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${1:-8087}"
WEB_PORT="${2:-5173}"
LOG_DIR="${COMFYUI_WEB_DEV_LOG_DIR:-/tmp}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "启动：backend=$BACKEND_PORT  web=$WEB_PORT  日志目录=$LOG_DIR"

# 1) 后端宿主（tsx watch）
( cd "$CD/apps/server" && COMFYUI_WEB_PORT="$BACKEND_PORT" nohup pnpm dev > "$LOG_DIR/devhost.log" 2>&1 & )
sleep 10
# 探活用 /api/host 的 contract 字段：D19 删掉 profile 之后，原来 grep profile 的写法**永远**失败，
# 会在后端明明起来了的时候报"❌ 起不来"、然后连前端都不启动。
if curl -s -m 3 "http://127.0.0.1:$BACKEND_PORT/api/host" | grep -q '"contract"'; then
  log "后端 ✅ http://127.0.0.1:$BACKEND_PORT"
else
  log "后端 ❌ 起不来（端口被占？），见 $LOG_DIR/devhost.log"
  tail -5 "$LOG_DIR/devhost.log"
  exit 1
fi

# 2) 前端外壳（vite dev，顶到入口端口）
( cd "$CD/apps/web" && COMFYUI_WEB_PORT="$BACKEND_PORT" COMFYUI_WEB_DEV_PORT="$WEB_PORT" \
    nohup pnpm dev > "$LOG_DIR/devweb.log" 2>&1 & )
sleep 14
web=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/w/anima-plus")
web2=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/w/anima-example")
api=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/plugins")
log "前端 /w/anima-plus=$web  /w/anima-example=$web2  /api/plugins=$api（不是 200 就看 $LOG_DIR/devweb.log）"

# 3) 插件前端 watch：**所有**带 vite.config.ts 的插件（有前端产物的就是它）
for dir in "$CD"/plugins/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/vite.config.ts" ] || continue
  ( cd "$dir" && nohup pnpm dev > "$LOG_DIR/devplugin-$name.log" 2>&1 & )
  log "插件 watch：$name → $LOG_DIR/devplugin-$name.log"
done
sleep 5
log "完成：浏览器打开入口端口（本机是 nginx 的 5180）"
