#!/usr/bin/env bash
cd "$(dirname "$0")"
./uninstall.sh
echo
read -n 1 -s -r -p "按任意键关闭这个窗口…"
