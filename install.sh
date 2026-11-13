#!/usr/bin/env bash
# 一键安装:把船期工作台装进 DeepSeek Harness 的 profile。
#
# 注意:直接往 profile/node_modules 里拷包会被 pnpm 当成"多余依赖"清理掉
# (装别的插件时 pnpm install 会 prune)。所以这里:
#   1) 包放到 <profile>/plugins/shipping-workbench
#   2) 写进 <profile>/package.json 的 dependencies(file: 引用)
#   3) node_modules 里建软链,loader 就能按包名解析
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"

if [ ! -d "$DSH_HOME_DIR/profiles/$PROFILE" ] && [ -d "$DSH_HOME_DIR/profiles/web" ]; then
  PROFILE="web"
fi
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "找不到 DSH profile:$PROFILE_DIR"
  echo "先打开一次 DeepSeek Harness 让它初始化 profile,再运行本脚本。"
  exit 1
fi

TARGET="$PROFILE_DIR/plugins/shipping-workbench"
mkdir -p "$TARGET" "$PROFILE_DIR/node_modules"

echo "安装到:$TARGET"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$HERE/lib" "$HERE/ui" "$HERE/src" "$HERE/scripts" "$TARGET/"
cp "$HERE/package.json" "$HERE/README.md" "$HERE/cordis.patch.yml" "$HERE/update.command" "$HERE/restart.command" "$TARGET/"

# 1) 依赖声明:pnpmp 只会清理"package.json 里没有"的包
python3 - "$PROFILE_DIR/package.json" "$TARGET" <<'PY'
import json, sys
package_file, target = sys.argv[1], sys.argv[2]
with open(package_file) as handle:
    data = json.load(handle)
deps = data.setdefault("dependencies", {})
deps["shipping-workbench"] = "file:plugins/shipping-workbench"
with open(package_file, "w") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

# 2) node_modules 软链(下一步 pnpm install 会把它变成正式链接)
LINK="$PROFILE_DIR/node_modules/shipping-workbench"
rm -rf "$LINK"
ln -s "../plugins/shipping-workbench" "$LINK"

# 3) loader 条目
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  printf '[]\n' > "$PATCH"
fi
if grep -q "shipping-workbench" "$PATCH"; then
  echo "patch 里已有条目,跳过"
else
  cat >> "$PATCH" <<'YAML'

- insert:
    - id: shipping-workbench
      name: shipping-workbench
YAML
  echo "已写入 $PATCH"
fi

echo
echo "完成。重启 DeepSeek Harness 后,侧栏底部会出现「船期工作台」。"
echo "卸载:运行本目录的 uninstall.sh"
