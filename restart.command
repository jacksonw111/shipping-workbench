#!/usr/bin/env bash
# 退出并重开 DeepSeek Harness,让新装的插件生效。
set -euo pipefail
echo "正在退出 DeepSeek Harness…"
osascript -e 'tell application "DeepSeek Harness" to quit' >/dev/null 2>&1 || true
sleep 3
echo "正在重新打开…"
open -a "DeepSeek Harness"
echo "完成。侧栏底部应出现「船期工作台」。"
