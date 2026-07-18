#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v pm2 >/dev/null 2>&1; then pm2 delete taobao-shangou-daily-report >/dev/null 2>&1 || true; fi
for pid_file in "$APP_DIR/logs/app.pid" "$APP_DIR/logs/chrome.pid" "$APP_DIR/logs/xvfb.pid"; do
  if [[ -s "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    kill "$pid" >/dev/null 2>&1 || true
    rm -f "$pid_file"
  fi
done
echo '淘宝闪购云端日报服务已停止'
