#!/usr/bin/env bash
# ============================================================================
# deploy.sh 脚本部署形态（--mode script）本地端到端自测
# 不依赖 SSH/真实服务器：直接以 bash 执行 deploy.sh，对临时「安装根」走完整
# deploy / rollback 流程。fake 项目的 upgrade.sh/start.sh/stop.sh 模拟
# 「备份→停旧→切 CURRENT→启动→健康→失败回滚」契约（同 Vantage 形态）。
# 运行：bash scripts/deploy-script-e2e.sh
# ============================================================================
set -uo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SH="$REPO/electron/deploy/scripts/deploy.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deploy-script-e2e-XXXXXX")"
APP="$ROOT/app-home"      # 模拟服务器上的远程部署目录（安装根）
STAGE="$ROOT/staging"     # 本地打包 staging
trap 'rm -rf -- "$ROOT"' EXIT

pass=0; fail=0
ok_()  { pass=$((pass+1)); echo "  ✓ $1"; }
bad_() { fail=$((fail+1)); echo "  ✗ $1"; }
assert_eq() { # 实际 期望 描述
  if [ "$1" = "$2" ]; then ok_ "$3"; else bad_ "$3（期望 [$2] 实际 [$1]）"; fi
}
assert_has() { # 文本 子串 描述
  if printf '%s' "$1" | grep -q "$2"; then ok_ "$3"; else bad_ "$3（输出中未找到: $2）"; fi
}
assert_file() { if [ -e "$2" ]; then ok_ "$1"; else bad_ "$1（缺失: $2）"; fi }
assert_no_file() { if [ ! -e "$2" ]; then ok_ "$1"; else bad_ "$1（不应存在: $2）"; fi }

mkdir -p "$APP" "$STAGE"

# ── fake 项目发布包：单顶层目录 + VERSION + upgrade/start/stop ──
# $1=目录名  $2=success|fail（升级脚本行为）
make_pkg() {
  local name="$1" behaviour="$2" d="$STAGE/$1"
  rm -rf -- "$d"; mkdir -p -- "$d"
  printf '%s\n' "${name#app-v}" > "$d/VERSION"
  cat > "$d/upgrade.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SD="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
IR="\$INSTALL_ROOT"
echo "[fake-upgrade] \$(cat "\$IR/CURRENT" 2>/dev/null || echo none) -> \$(basename -- "\$SD")"
echo "[env] java=\$(command -v java 2>/dev/null || echo none) pgdump=\${PG_DUMP:-none}"
if [ "$behaviour" = "fail" ]; then echo "[fake-upgrade] 模拟升级失败"; exit 7; fi
mkdir -p "\$IR/backups"; touch "\$IR/backups/backup-\$(date +%s%N).tar.gz"
if [ -f "\$IR/CURRENT" ]; then
  old="\$(cat "\$IR/CURRENT")"
  if [ -f "\$IR/releases/\$old/stop.sh" ]; then INSTALL_ROOT="\$IR" bash "\$IR/releases/\$old/stop.sh" || true; fi
fi
printf '%s\n' "\$(basename -- "\$SD")" > "\$IR/CURRENT"
INSTALL_ROOT="\$IR" bash "\$SD/start.sh"
EOF
  cat > "$d/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IR="${INSTALL_ROOT:-$(dirname -- "$SD")}"
echo $$ > "$SD/app.pid"
touch "$SD/.started" "$IR/.service-running-$(basename -- "$SD")"
echo "[fake-start] $(basename -- "$SD") 已启动"
EOF
  cat > "$d/stop.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
rm -f "$SD/.started"
echo "[fake-stop] $(basename -- "$SD") 已停止"
EOF
  ( cd -- "$STAGE" && tar -czf "$name.tar.gz" "$name" )
  printf '%s\n' "$STAGE/$name.tar.gz"
}

# ── 执行一次发布（把包放到 uploads/ 再调 deploy.sh，等价客户端上传后） ──
# 其余参数原样透传（--health-url 等）；OUT/RC 保存结果
run_deploy() {
  local pkgfile="$1"; shift
  mkdir -p "$APP/uploads"
  cp -- "$pkgfile" "$APP/uploads/"
  local sum
  sum="$(sha256sum -- "$APP/uploads/$(basename -- "$pkgfile")" | awk '{print $1}')"
  OUT="$(bash "$DEPLOY_SH" deploy --mode script --app fakeapp --home "$APP" \
    --package "$(basename -- "$pkgfile")" --sha256 "$sum" \
    --version "$(basename -- "$pkgfile" .tar.gz)" "$@" 2>&1)"
  RC=$?
}

current_is() { assert_eq "$(tr -d '[:space:]' < "$APP/CURRENT" 2>/dev/null || echo none)" "$1" "CURRENT 指向 $1"; }

echo "S1 首次部署成功（无旧版本）"
P1="$(make_pkg app-v1.0.0-001 success)"
run_deploy "$P1" --keep-releases 10 --delete-upload
assert_eq "$RC" 0 "退出码 0"
assert_has "$OUT" '__DEPLOY_OK__:app-v1.0.0-001' '输出成功标记'
current_is app-v1.0.0-001
assert_file '新版本 start.sh 已执行（.started）' "$APP/releases/app-v1.0.0-001/.started"
assert_no_file '成功后上传包已清理' "$APP/uploads/app-v1.0.0-001.tar.gz"

echo "S2 升级成功（停旧 + CURRENT 切新，旧版本保留）"
P2="$(make_pkg app-v1.0.0-002 success)"
run_deploy "$P2" --keep-releases 10 --keep-upload
assert_eq "$RC" 0 "退出码 0"
current_is app-v1.0.0-002
assert_no_file '旧版本已被 stop（.started 移除）' "$APP/releases/app-v1.0.0-001/.started"
assert_file '旧版本目录保留' "$APP/releases/app-v1.0.0-001/VERSION"
assert_file 'keep-upload 时上传包保留' "$APP/uploads/app-v1.0.0-002.tar.gz"

echo "S3 升级脚本失败 → 尽力恢复 CURRENT 指向版本"
P3="$(make_pkg app-v1.0.0-003 fail)"
before="$(stat -c %Y "$APP/releases/app-v1.0.0-002/.started" 2>/dev/null || echo 0)"
sleep 1
run_deploy "$P3" --keep-releases 10 --delete-upload
assert_eq "$RC" 1 "退出码非 0"
assert_has "$OUT" '__DEPLOY_FAIL__' '输出失败标记'
assert_has "$OUT" '尽力恢复' '触发尽力恢复路径'
current_is app-v1.0.0-002
after="$(stat -c %Y "$APP/releases/app-v1.0.0-002/.started" 2>/dev/null || echo 0)"
if [ "$after" -gt "$before" ]; then ok_ '当前版本被幂等拉起（.started 时间更新）'; else bad_ "当前版本未被拉起（before=$before after=$after）"; fi
assert_no_file '失败版本未执行 start' "$APP/releases/app-v1.0.0-003/.started"

echo "S4 升级成功但 HTTP 健康复查失败 → 自动回滚旧版本"
P4="$(make_pkg app-v1.0.0-004 success)"
# 只在本场景模拟健康接口：旧版本运行时可达，新版本运行时失败。
# 发布前后始终不可达属于地址配置问题，不能作为自动回滚的前提。
health_bin="$ROOT/s4-bin"; mkdir -p -- "$health_bin"
curl_original="$(command -v curl)"
cat > "$health_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [ "$argument" = 'http://fake-service.invalid/health' ]; then
    current="$(tr -d '[:space:]' < "$E2E_HEALTH_APP/CURRENT")"
    if [ "$current" = app-v1.0.0-002 ] && [ -f "$E2E_HEALTH_APP/releases/$current/.started" ]; then
      printf '%s healthy\n' "$current" >> "$E2E_HEALTH_APP/.health-probes"
      exit 0
    fi
    printf '%s unhealthy\n' "$current" >> "$E2E_HEALTH_APP/.health-probes"
    exit 22
  fi
done
exec "$E2E_CURL_ORIGINAL" "$@"
EOF
chmod +x "$health_bin/curl"
E2E_HEALTH_APP="$APP" E2E_CURL_ORIGINAL="$curl_original" PATH="$health_bin:$PATH" \
  run_deploy "$P4" --keep-releases 10 --delete-upload \
  --health-url 'http://fake-service.invalid/health' --health-timeout 4 --health-interval 1
assert_has "$OUT" '发布前健康探测可达' '升级前旧版本健康可达'
assert_eq "$RC" 1 "退出码非 0"
assert_has "$OUT" '__DEPLOY_FAIL__' '输出失败标记'
assert_has "$OUT" '已自动回滚到 app-v1.0.0-002' '提示回滚目标'
current_is app-v1.0.0-002
assert_no_file '新版本已 stop' "$APP/releases/app-v1.0.0-004/.started"
assert_file '旧版本已重启' "$APP/releases/app-v1.0.0-002/.started"
assert_eq "$(head -1 "$APP/.health-probes")" 'app-v1.0.0-002 healthy' '首次健康探测命中运行中的旧版本'
assert_has "$(cat "$APP/.health-probes")" 'app-v1.0.0-004 unhealthy' '新版本健康探测失败'
assert_eq "$(tail -1 "$APP/.health-probes")" 'app-v1.0.0-002 healthy' '回滚后旧版本健康恢复'

echo "S5 手动回滚子命令（--mode script rollback）"
OUT="$(bash "$DEPLOY_SH" rollback --mode script --home "$APP" --version app-v1.0.0-001 2>&1)"; RC=$?
assert_eq "$RC" 0 "退出码 0"
assert_has "$OUT" '__DEPLOY_OK__:app-v1.0.0-001' '输出成功标记'
current_is app-v1.0.0-001
assert_file '目标版本已启动' "$APP/releases/app-v1.0.0-001/.started"
assert_no_file '原版本已停止' "$APP/releases/app-v1.0.0-002/.started"

echo "S6 手动回滚到不存在的版本报错"
OUT="$(bash "$DEPLOY_SH" rollback --mode script --home "$APP" --version app-v9.9.9 2>&1)"; RC=$?
assert_eq "$RC" 1 "退出码非 0"
assert_has "$OUT" '目标版本不存在' '输出错误原因'

echo "S7 SHA256 校验失败拒发"
P5="$(make_pkg app-v1.0.0-005 success)"
mkdir -p "$APP/uploads"; cp -- "$P5" "$APP/uploads/"
OUT="$(bash "$DEPLOY_SH" deploy --mode script --app fakeapp --home "$APP" \
  --package app-v1.0.0-005.tar.gz --sha256 "$(printf 'x%.0s' {1..64})" \
  --version app-v1.0.0-005 2>&1)"; RC=$?
assert_eq "$RC" 1 "退出码非 0"
assert_has "$OUT" '校验失败' '输出校验失败'
assert_no_file '未解压出新版本' "$APP/releases/app-v1.0.0-005"
current_is app-v1.0.0-001

echo "S8 发布包含多个顶层目录 → 拒绝"
bad="$STAGE/app-v1.0.0-006.tar.gz"
( cd -- "$STAGE" && mkdir -p multi-a multi-b \
  && cp app-v1.0.0-001/start.sh multi-a/ && cp app-v1.0.0-001/stop.sh multi-b/ \
  && tar -czf app-v1.0.0-006.tar.gz multi-a multi-b )
run_deploy "$bad" --keep-releases 10 --delete-upload
assert_eq "$RC" 1 "退出码非 0"
assert_has "$OUT" '顶层目录' '输出顶层目录错误'
assert_no_file 'releases 未残留 incoming' "$(ls -d "$APP/releases/.incoming."* 2>/dev/null | head -1)"

echo "S9 keep-releases 清理：只保留最近 N 个且不删 CURRENT 指向"
for v in 006 007; do
  Pv="$(make_pkg "app-v1.0.0-$v" success)"
  run_deploy "$Pv" --keep-releases 2 --delete-upload
  assert_eq "$RC" 0 "部署 $v 成功"
done
current_is app-v1.0.0-007
n="$(ls -1 "$APP/releases" | wc -l)"
if [ "$n" -le 2 ]; then ok_ "releases 已收敛到 ≤2（实际 $n）"; else bad_ "releases 未收敛（实际 $n）"; fi
assert_file 'CURRENT 指向版本未被清理' "$APP/releases/app-v1.0.0-007/VERSION"

echo "S10 zip 发布包同样可用（archiver 生成）"
zdir="$STAGE/zip-pkg"; rm -rf -- "$zdir"; mkdir -p -- "$zdir/app-v1.0.0-008"
cp "$STAGE/app-v1.0.0-001/upgrade.sh" "$STAGE/app-v1.0.0-001/start.sh" "$STAGE/app-v1.0.0-001/stop.sh" "$zdir/app-v1.0.0-008/"
# Windows 原生 node 不识别 MSYS 的 /tmp、/d/ 路径，统一转为 Windows 格式
to_win() { cd -- "$1" && pwd -W 2>/dev/null || cygpath -m "$1"; }
zdir_w="$(to_win "$zdir")"; repo_w="$(to_win "$REPO")"
node -e "
(async () => {
  const archiver = require('$repo_w/node_modules/archiver')
  const fs = require('fs')
  const out = fs.createWriteStream('$zdir_w/pkg.zip')
  const a = archiver('zip'); a.pipe(out)
  a.directory('$zdir_w/app-v1.0.0-008', 'app-v1.0.0-008')
  await a.finalize()
  await new Promise((r) => out.on('close', r))
})().catch((e) => { console.error(e); process.exit(1) })
"
run_deploy "$zdir/pkg.zip" --keep-releases 10 --delete-upload
assert_eq "$RC" 0 "退出码 0"
current_is app-v1.0.0-008
assert_file 'zip 包内 start.sh 已执行' "$APP/releases/app-v1.0.0-008/.started"

echo "S11 环境引导：toolbox 的 JDK/pg_dump 优先并导出给项目脚本"
mkdir -p "$APP/shared/toolbox/jdk/bin" "$APP/shared/toolbox/bin"
printf '%s\n' '#!/usr/bin/env bash' 'echo "openjdk version \"17.9.9\" 2026-01-01" >&2' > "$APP/shared/toolbox/jdk/bin/java"
printf '%s\n' '#!/usr/bin/env bash' 'echo "toolbox-pgdump-wrapper"' > "$APP/shared/toolbox/bin/pg_dump"
chmod +x "$APP/shared/toolbox/jdk/bin/java" "$APP/shared/toolbox/bin/pg_dump"
P8="$(make_pkg app-v1.0.0-009 success)"
run_deploy "$P8" --keep-releases 10 --delete-upload
assert_eq "$RC" 0 "退出码 0"
assert_has "$OUT" '使用工具箱 JDK' '日志提示使用工具箱 JDK'
assert_has "$OUT" "java=$APP/shared/toolbox/jdk/bin/java" 'PATH 已导出 toolbox JDK'
assert_has "$OUT" "pgdump=$APP/shared/toolbox/bin/pg_dump" 'PG_DUMP 已导出 toolbox 包装'

echo
echo "结果: $pass 通过, $fail 失败"
exit "$([ "$fail" -eq 0 ] && echo 0 || echo 1)"
