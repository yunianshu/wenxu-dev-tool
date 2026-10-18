#!/usr/bin/env bash
# 随发布包携带；参数只接收项目发布事务，不接受任意命令。
set -euo pipefail
CONTAINER='__CONTAINER_NAME__'
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TX="${1:?缺少同步事务}"
[[ "$TX" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$ ]] || exit 1
STAGING="/tmp/project-tool-openclaw-$TX"
NODE=""
APPLIED=0
worker() { docker exec --user 0 "$CONTAINER" "$NODE" "$STAGING/worker.mjs" "$1" "$STAGING/manifest.json" "$TX"; }
wait_ready() {
  local state
  for ((i=0; i<45; i++)); do
    state="$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")" || return 1
    if [ "$state" = 'true healthy' ] || [ "$state" = 'true none' ]; then return 0; fi
    sleep 2
  done
  return 1
}
recover() {
  trap '' HUP INT TERM
  trap - ERR
  if [ "$APPLIED" = 1 ]; then
    echo '[WARN] 恢复本次 OpenClaw 文件变更'
    if worker restore && docker restart "$CONTAINER" >/dev/null && wait_ready; then
      echo '[OK] OpenClaw 已恢复更新前文件并重新启动'
    else echo '[ERROR] OpenClaw 恢复未完成，请保留同步事务备份并人工检查'; fi
  fi
  exit 1
}
trap recover ERR HUP INT TERM
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true ] || { echo '[ERROR] OpenClaw 容器未运行'; exit 1; }
NODE="$(docker exec --user 0 "$CONTAINER" sh -c 'command -v node || { test -x /opt/node/bin/node && printf %s /opt/node/bin/node; }')"
[ -n "$NODE" ] || { echo '[ERROR] OpenClaw 容器中未找到 Node'; exit 1; }
docker exec --user 0 "$CONTAINER" sh -c 'test ! -e "$1" && mkdir -m 700 "$1"' sh "$STAGING"
docker cp "$DIR/." "$CONTAINER:$STAGING/" >/dev/null
APPLIED=1
if ! RESULT="$(worker apply)"; then recover; fi
echo "[INFO] OpenClaw 文件检查：$RESULT"
if [[ "$RESULT" != *'"changed":0'* ]]; then
  docker restart "$CONTAINER" >/dev/null || recover
  wait_ready || { echo '[ERROR] OpenClaw 重启后未就绪'; recover; }
fi
worker verify || recover
worker commit || recover
APPLIED=0
trap - ERR HUP INT TERM
docker exec --user 0 "$CONTAINER" rm -rf -- "$STAGING" || echo '[WARN] OpenClaw 临时目录待清理'
echo '[OK] OpenClaw 插件及 Skill 内容、版本和加载状态已核验'
