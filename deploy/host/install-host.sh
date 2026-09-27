#!/usr/bin/env bash
# 把 deploy/host/ 下的主机级配置装到 124 上。可重复执行，内容没变就什么都不写。
#
#   install-host.sh launcher   只保证 t3 拦截层在位（t3code-portwatch 每 10 秒调一次）
#   install-host.sh all        另装 systemd 用户单元（t3code-deploy 每次发布调一次）
#
# 密钥文件 ~/.t3/t3code-msghub.env、~/.t3/t3code-memsearch.env 只在本机，
# 本脚本只引用、不创建也不改动它们。
set -Eeuo pipefail

HOST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${T3_RUNTIME_ROOT:-/home/ubuntu/.t3/runtime/versions}
USER_UNIT_DIR=${T3_USER_UNIT_DIR:-/home/ubuntu/.config/systemd/user}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
LAUNCHER_MARKER="# t3 launcher 拦截层"

is_interceptor() {
  head -c 64 "$1" 2>/dev/null | grep -qF "$LAUNCHER_MARKER"
}

# 装到 dest，内容相同时不动；返回 0 表示有变化。
install_file() {
  local src=$1 dest=$2 mode=$3
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    return 1
  fi
  install -D -m "$mode" "$src" "$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
  echo "install-host: updated $dest"
}

# 桌面端每个版本目录里的 t3 都要换成拦截层。`t3 update` 或桌面端升级会
# 整目录替换，届时 t3 又是官方二进制，先改名为 t3-official 再装拦截层。
install_launcher() {
  local dir
  for dir in "$RUNTIME_ROOT"/*/; do
    [ -x "$dir/t3" ] || continue
    if ! is_interceptor "$dir/t3"; then
      mv -f "$dir/t3" "$dir/t3-official"
      echo "install-host: moved official binary to $dir/t3-official"
    fi
    [ -x "$dir/t3-official" ] || continue
    install_file "$HOST_DIR/t3-launcher.sh" "$dir/t3" 0755 || true
  done
}

install_units() {
  local changed=0 f rel
  while IFS= read -r f; do
    rel=${f#"$HOST_DIR/systemd/"}
    install_file "$f" "$USER_UNIT_DIR/$rel" 0644 && changed=1
  done < <(find "$HOST_DIR/systemd" -type f | sort)
  if [ "$changed" = 1 ]; then
    systemctl --user daemon-reload
  fi
  systemctl --user enable --now t3code-portwatch.timer >/dev/null 2>&1
  # 迁移前的旧位置，单元已改指向 /opt/t3code/deploy/host。
  rm -f /home/ubuntu/.t3/t3code-portwatch.sh /home/ubuntu/.t3/t3-port-forward.mjs
}

case "${1:-}" in
launcher) install_launcher ;;
all)
  install_launcher
  install_units
  ;;
*)
  echo "usage: $0 launcher|all" >&2
  exit 2
  ;;
esac
