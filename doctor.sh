#!/usr/bin/env bash
# 检查插件是否装好、loader 能否解析、工作台接口是否在响应。
set -uo pipefail
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
ok=0; bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ✔ $1"; ok=$((ok+1)); else echo "  �’ $1"; bad=$((bad+1)); fi; }

echo "profile: $PROFILE_DIR"
check "插件目录存在" "test -f '$PROFILE_DIR/plugins/shipping-workbench/package.json'"
check "profile 依赖已声明" "grep -q shipping-workbench '$PROFILE_DIR/package.json'"
check "node_modules 链接存在" "test -e '$PROFILE_DIR/node_modules/shipping-workbench'"
check "cordis.patch.yml 有条目" "grep -q shipping-workbench '$PROFILE_DIR/cordis.patch.yml'"

if command -v node >/dev/null 2>&1; then
  check "loader 能解析包" "node -e \"import('shipping-workbench').then(()=>process.exit(0),()=>process.exit(1))\" --input-type=module"
fi

if [ -n "${DSH_WEB_URL:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$DSH_WEB_URL/shipping-workbench/api/bootstrap" || echo 000)
  if [ "$code" = "200" ]; then echo "  ✔ 工作台接口 200"; ok=$((ok+1)); else echo "  ✘ 工作台接口 $code(未加载或需要刷新/重启)"; bad=$((bad+1)); fi
fi

echo "通过 $ok 项,失败 $bad 项"
[ "$bad" -eq 0 ]
