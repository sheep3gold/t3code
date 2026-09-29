#!/bin/sh
# t3 launcher 拦截层
#
# 由仓库 deploy/host/t3-launcher.sh 管理：t3code-deploy 发布时、以及
# t3code-portwatch 每 10 秒检查时，都会把它装到 ~/.t3/runtime/versions/*/t3，
# 原官方二进制改名为同目录的 t3-official。`t3 update` 或桌面端升级带来的新
# 版本目录会被自动重新拦截。
#
# 背景：T3 桌面端的远程环境功能会通过 SSH 起 `t3 serve --port <P>
# --base-dir ~/.t3`。P 由桌面端自己从 3773 起往上挑一个空闲端口。
#
# 这台机器上唯一权威的服务是用户级 systemd 的 t3code.service（固定 3773，
# 带 Kiro provider 与 memsearch 等环境变量；手机端经 nginx 也连它）。
# 桌面端若另起一个 serve，两个进程会共用同一个 ~/.t3/userdata/state.sqlite，
# 但各自在内存里维护会话与推送——一端产生的新消息另一端看不到（实测：
# 桌面端连到 3774 的实例，手机端停在 3773 实例重启前的内容）。
#
# 策略：只拦 serve / start 两个子命令，其余原样转交官方二进制，
# 因此 `t3 auth`、`t3 project`、`t3 service`、`t3 --version` 行为不变。
#
#   * 先确保 t3code.service 在跑，并等 3773 就绪。
#   * P == 3773          → 直接退出，桌面端 wait_ready 后复用它。
#   * P != 3773          → 在 P 上起一个纯 TCP 转发到 3773，不再起第二个服务。
#   * systemd 起不来     → 退回旧行为：用自建 build 在 P 上起服务，
#                          宁可暂时分裂也不要桌面端完全连不上。
#
# 官方二进制被改名为 t3-official（未删除，仍是唯一回滚件）。

set -u

# 经 ~/.local/bin/t3 这个符号链接调用时，$0 是链接自身，dirname 会落在
# ~/.local/bin 而不是版本目录，导致找不到 t3-official。先解析真实路径。
SELF=$(readlink -f -- "$0" 2>/dev/null || echo "$0")
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
OFFICIAL="$SELF_DIR/t3-official"
SELFBUILT="/home/ubuntu/.t3/selfbuilt/t3code/apps/server/dist/bin.mjs"
FORWARDER="/opt/t3code/deploy/host/t3-port-forward.mjs"
NODE="/usr/local/bin/node"
AUTHORITATIVE_PORT=3773

listening() {
    ss -tln 2>/dev/null | grep -qE "127\.0\.0\.1:${1}[[:space:]]"
}

# SSH 会话里不一定带 XDG_RUNTIME_DIR，显式指定才能连上用户级 systemd。
user_systemctl() {
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@"
}

ensure_authoritative() {
    deploy_state=$(systemctl is-active t3code-deploy.service 2>/dev/null || true)
    if [ "$deploy_state" != "inactive" ] && [ "$deploy_state" != "failed" ]; then
        i=0
        while [ "$i" -lt 180 ]; do
            listening "$AUTHORITATIVE_PORT" && return 0
            i=$((i + 1))
            sleep 1
        done
        return 1
    fi
    if ! listening "$AUTHORITATIVE_PORT"; then
        user_systemctl reset-failed t3code.service >/dev/null 2>&1 || true
        # --no-block：等端口就绪由下面的循环负责，不要卡在 systemctl 上。
        user_systemctl start --no-block t3code.service >/dev/null 2>&1 || return 1
    fi
    i=0
    while [ "$i" -lt 60 ]; do
        listening "$AUTHORITATIVE_PORT" && return 0
        i=$((i + 1))
        sleep 1
    done
    return 1
}

case "${1:-}" in
serve | start)
    # 从参数里取 --port，缺省 3773。
    port=$AUTHORITATIVE_PORT
    prev=""
    for a in "$@"; do
        case "$prev" in
        --port) port="$a" ;;
        esac
        case "$a" in
        --port=*) port=${a#--port=} ;;
        esac
        prev="$a"
    done

    if ensure_authoritative; then
        if [ "$port" = "$AUTHORITATIVE_PORT" ]; then
            echo "t3: 127.0.0.1:${port} 由 t3code.service 提供，本次 ${1} 跳过。" >&2
            exit 0
        fi
        if [ -f "$FORWARDER" ] && [ -x "$NODE" ]; then
            echo "t3: 桌面端选了 ${port}，转发到 t3code.service（${AUTHORITATIVE_PORT}），不另起服务。" >&2
            exec "$NODE" "$FORWARDER" "$port" "$AUTHORITATIVE_PORT"
        fi
    fi

    if listening "$port"; then
        echo "t3: 127.0.0.1:${port} 已有服务在跑，本次 ${1} 跳过。" >&2
        exit 0
    fi

    if [ -f "$SELFBUILT" ] && [ -x "$NODE" ]; then
        echo "t3: t3code.service 不可用，用自建 build 在 ${port} 上启动（含 Kiro provider）。" >&2
        exec "$NODE" "$SELFBUILT" "$@"
    fi

    # 自建 build 不可用时退回官方，宁可少 Kiro 也不要没有服务。
    echo "t3: 自建 build 缺失，退回官方 launcher。" >&2
    exec "$OFFICIAL" "$@"
    ;;
esac

exec "$OFFICIAL" "$@"
