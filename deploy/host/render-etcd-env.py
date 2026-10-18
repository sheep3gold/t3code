#!/usr/bin/env python3
"""从 etcd 的 t3code/ 前缀渲染 t3code.service 的环境变量文件。

t3code.service 的 ExecStartPre 调用它；服务读的是渲染结果
~/.t3/t3code-etcd.env，etcd 的读凭证留在引导文件里，不进服务进程环境。

key 到环境变量的映射是固定规则：t3code/msghub/host_label ->
T3CODE_MSGHUB_HOST_LABEL。在 config-ui 里新增 key 不需要改这里，
重启 t3code.service（或下次发布）后生效。以 _ 开头的 key（如 _readme）跳过。

etcd 不可达时保留上一次渲染的文件并正常退出：让一次重启静默丢掉 msghub、
memsearch 等配置，比沿用旧值更难排查（与 etcd-config 客户端库的快照语义一致）。
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import urllib.request

BOOTSTRAP = os.path.expanduser("~/.t3/t3code-etcd-bootstrap.env")
OUTPUT = os.path.expanduser("~/.t3/t3code-etcd.env")
ENV_PREFIX = "T3CODE_"


def log(message: str) -> None:
    print(f"render-etcd-env: {message}", file=sys.stderr)


def read_bootstrap() -> dict[str, str]:
    values: dict[str, str] = {}
    with open(BOOTSTRAP, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def fetch(cfg: dict[str, str]) -> list[tuple[str, str]]:
    prefix = cfg.get("ETCD_KV_PREFIX", "t3code/")
    range_end = prefix[:-1] + chr(ord(prefix[-1]) + 1)
    body = json.dumps({
        "key": base64.b64encode(prefix.encode()).decode(),
        "range_end": base64.b64encode(range_end.encode()).decode(),
    }).encode()
    request = urllib.request.Request(
        cfg["ETCD_ENDPOINT"].rstrip("/") + "/v3/kv/range", data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    token = base64.b64encode(f"{cfg['ETCD_BASIC_USER']}:{cfg['ETCD_BASIC_PASS']}".encode()).decode()
    request.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.load(response)
    if "header" not in payload:
        raise RuntimeError(f"unexpected etcd response: {str(payload)[:200]}")
    pairs = []
    for kv in payload.get("kvs", []):
        key = base64.b64decode(kv["key"]).decode()
        value = base64.b64decode(kv.get("value", "")).decode()
        pairs.append((key[len(prefix):], value))
    return pairs


def to_env_line(rel_key: str, value: str) -> str | None:
    if not rel_key or rel_key.startswith("_") or "\n" in value:
        return None
    name = ENV_PREFIX + rel_key.upper().replace("/", "_").replace("-", "_")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{name}="{escaped}"'


def main() -> int:
    try:
        cfg = read_bootstrap()
    except FileNotFoundError:
        log(f"{BOOTSTRAP} missing; keeping {OUTPUT} as is")
        return 0
    pairs: list[tuple[str, str]] | None = None
    for attempt in range(3):
        try:
            pairs = fetch(cfg)
            break
        except Exception as exc:  # noqa: BLE001 - any failure falls back to the snapshot
            log(f"etcd fetch attempt {attempt + 1} failed: {exc}")
            time.sleep(1)
    if pairs is None:
        state = "keeping last snapshot" if os.path.exists(OUTPUT) else "no snapshot yet"
        log(f"etcd unreachable; {state} at {OUTPUT}")
        return 0
    lines = []
    for rel_key, value in sorted(pairs):
        line = to_env_line(rel_key, value)
        if line is None:
            log(f"skipped key {rel_key!r}")
        else:
            lines.append(line)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUTPUT), prefix=".t3code-etcd.env.")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("# 由 render-etcd-env.py 从 etcd t3code/ 渲染，勿手改\n")
        fh.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, OUTPUT)
    log(f"rendered {len(lines)} keys to {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
