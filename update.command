#!/usr/bin/env bash
# 从 GitHub 跟随更新船期工作台插件。
#   ./update.command            # 检查并更新
#   ./update.command --check    # 只看有没有新版本
#   ./update.command --restart  # 更新完自动重启 DeepSeek Harness
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/scripts/update-from-github.mjs" "$@"
