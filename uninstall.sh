#!/usr/bin/env bash
# 卸载船期工作台。
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
TARGET="$PROFILE_DIR/plugins/shipping-workbench"
PATCH="$PROFILE_DIR/cordis.patch.yml"

rm -rf "$TARGET" "$PROFILE_DIR/node_modules/shipping-workbench"
echo "已删除 $TARGET"

python3 - "$PROFILE_DIR/package.json" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as handle:
        data = json.load(handle)
except FileNotFoundError:
    raise SystemExit(0)
deps = data.get("dependencies", {})
deps.pop("shipping-workbench", None)
with open(path, "w") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
echo "已移除依赖声明"

if [ -f "$PATCH" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$PATCH" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
text = path.read_text()
text = re.sub(r"\n- insert:\n(?:    .*\n)+?      name: shipping-workbench\n", "\n", text)
path.write_text(text)
PY
  echo "已清理 patch 条目"
fi

echo "重启 DeepSeek Harness 后生效。数据目录 ~/.dsh/shipping-workbench 未删除。"
