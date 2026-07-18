#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

read_numeric_env() {
  local name="$1"
  awk -F= -v key="$name" '$1 == key { gsub(/[[:space:]\"\047]/, "", $2); print $2; exit }' "$APP_DIR/.env" 2>/dev/null || true
}

read_text_env() {
  local name="$1"
  awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); gsub(/^[[:space:]\"\047]+|[[:space:]\"\047]+$/, ""); print; exit }' "$APP_DIR/.env" 2>/dev/null || true
}

export DISPLAY="${DISPLAY:-:99}"
CHROME_PORT="${CHROME_DEBUG_PORT:-$(read_numeric_env CHROME_DEBUG_PORT)}"
CHROME_PORT="${CHROME_PORT:-9222}"
CHROME_PROFILE="${CHROME_PROFILE:-$(read_text_env CHROME_PROFILE)}"
CHROME_PROFILE="${CHROME_PROFILE:-$HOME/taobao-shangou-chrome-profile}"
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)}"
if [[ -z "$CHROME_BIN" ]]; then
  echo '未找到 Chrome/Chromium，请先安装浏览器运行依赖' >&2
  exit 1
fi

mkdir -p "$APP_DIR/logs" "$APP_DIR/data/reports" "$CHROME_PROFILE"
if ! pgrep -f "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  nohup Xvfb "$DISPLAY" -screen 0 1280x720x24 -ac >"$APP_DIR/logs/xvfb.log" 2>&1 &
  echo $! > "$APP_DIR/logs/xvfb.pid"
  sleep 1
fi

if ! curl -fsS "http://127.0.0.1:${CHROME_PORT}/json/version" >/dev/null 2>&1; then
  nohup "$CHROME_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --window-size=1280,720 \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$CHROME_PROFILE" \
    'https://open.shop.ele.me/manager/base/store-analysis' \
    >"$APP_DIR/logs/chrome.log" 2>&1 &
  echo $! > "$APP_DIR/logs/chrome.pid"
fi

for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:${CHROME_PORT}/json/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${CHROME_PORT}/json/version" >/dev/null
if [[ "$(curl -fsS "http://127.0.0.1:${CHROME_PORT}/json")" == "[ ]" || "$(curl -fsS "http://127.0.0.1:${CHROME_PORT}/json")" == "[]" ]]; then
  curl -fsS -X PUT "http://127.0.0.1:${CHROME_PORT}/json/new?https%3A%2F%2Fopen.shop.ele.me%2Fmanager%2Fbase%2Fstore-analysis" >/dev/null
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete taobao-shangou-daily-report >/dev/null 2>&1 || true
  pm2 start cloud/server.mjs --name taobao-shangou-daily-report --cwd "$APP_DIR" --update-env
  pm2 save >/dev/null 2>&1 || true
else
  nohup node cloud/server.mjs >"$APP_DIR/logs/app.log" 2>&1 &
  echo $! > "$APP_DIR/logs/app.pid"
fi

echo '淘宝闪购云端日报服务已启动'
