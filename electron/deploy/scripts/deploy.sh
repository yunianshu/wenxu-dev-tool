#!/usr/bin/env bash
# ============================================================================
# OneDeploy 服务器端部署脚本
#
# 由 Windows 客户端经 SFTP 上传到 <部署目录>/deployer/deploy.sh 后通过 SSH 调用。
# 职责（方案 §10.2）：环境检查 / 备份 / 数据库备份 / 解压 / 版本目录管理 /
#   Docker 构建 / 重启 / 健康检查 / 自动回滚 / 清理旧版本与旧备份。
#
# 目录规范（方案 §8）：
#   <home>/
#     ├── current -> releases/<version>   软链接指向当前运行版本
#     ├── releases/  uploads/  backups/  shared/  deployer/
#
# 与客户端的协议：
#   阶段标记  __STAGE__:<name>        （backup-code / backup-db / extract / build / start / health / rollback）
#   结果标记  __DEPLOY_OK__:<msg>     __DEPLOY_FAIL__:<msg>
#   日志等级  [INFO] [OK] [WARN] [ERROR]
# ============================================================================
set -uo pipefail

# ───────────────────────── 日志与标记 ─────────────────────────
log()  { echo "[INFO]  $*"; }
ok()   { echo "[OK]    $*"; }
warn() { echo "[WARN]  $*"; }
err()  { echo "[ERROR] $*"; }
stage(){ echo "__STAGE__:$1"; }

fail_now() { # 前置检查失败（尚未改动任何服务器状态），直接报告失败
  err "$1"
  echo "__DEPLOY_FAIL__:$1"
  exit 1
}

# ───────────────────────── 参数解析 ─────────────────────────
CMD="deploy"
MODE="docker" APP_NAME="" HOME_DIR="" PACKAGE="" SHA256="" VERSION="" COMPOSE_FILE="docker-compose.yml"
UPGRADE_SCRIPT="upgrade.sh"
RELEASE_ID="" PROJECT_NAME=""
BACKUP_CODE=1 BACKUP_DB=0 DB_TYPE="postgres" DB_CONTAINER="" DB_NAME="" DB_USER=""
AUTO_ROLLBACK=1 HEALTH_URL="" HEALTH_TIMEOUT=90 HEALTH_INTERVAL=3
KEEP_RELEASES=10 KEEP_BACKUPS=10 DELETE_UPLOAD=1
BOOTSTRAP_JAVA=0 BOOTSTRAP_PGDUMP=0

if [ $# -gt 0 ]; then CMD="$1"; shift; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)             MODE="$2"; shift 2 ;;
    --app)          APP_NAME="$2"; shift 2 ;;
    --home)         HOME_DIR="$2"; shift 2 ;;
    --package)      PACKAGE="$2"; shift 2 ;;
    --sha256)       SHA256="$2"; shift 2 ;;
    --compose)      COMPOSE_FILE="$2"; shift 2 ;;
    --upgrade-script) UPGRADE_SCRIPT="$2"; shift 2 ;;
    --version)      VERSION="$2"; shift 2 ;;
    --release-id)   RELEASE_ID="$2"; shift 2 ;;
    --project-name) PROJECT_NAME="$2"; shift 2 ;;
    --backup-code)      BACKUP_CODE=1; shift ;;
    --no-backup-code)   BACKUP_CODE=0; shift ;;
    --backup-db)        BACKUP_DB=1; shift ;;
    --no-backup-db)     BACKUP_DB=0; shift ;;
    --db-type)      DB_TYPE="$2"; shift 2 ;;
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --db-name)      DB_NAME="$2"; shift 2 ;;
    --db-user)      DB_USER="$2"; shift 2 ;;
    --auto-rollback)    AUTO_ROLLBACK=1; shift ;;
    --no-auto-rollback) AUTO_ROLLBACK=0; shift ;;
    --health-url)      HEALTH_URL="$2"; shift 2 ;;
    --health-timeout)  HEALTH_TIMEOUT="$2"; shift 2 ;;
    --health-interval) HEALTH_INTERVAL="$2"; shift 2 ;;
    --no-health)       HEALTH_URL=""; shift ;;
    --keep-releases) KEEP_RELEASES="$2"; shift 2 ;;
    --keep-backups)  KEEP_BACKUPS="$2"; shift 2 ;;
    --delete-upload) DELETE_UPLOAD=1; shift ;;
    --keep-upload)   DELETE_UPLOAD=0; shift ;;
    --bootstrap-java)    BOOTSTRAP_JAVA=1; shift ;;
    --no-bootstrap-java) BOOTSTRAP_JAVA=0; shift ;;
    --bootstrap-pgdump)    BOOTSTRAP_PGDUMP=1; shift ;;
    --no-bootstrap-pgdump) BOOTSTRAP_PGDUMP=0; shift ;;
    *) shift ;;
  esac
done
if [ -n "$PROJECT_NAME" ]; then
  [[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail_now "项目标识无效"
  export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
fi
if [ -n "$RELEASE_ID" ]; then [[ "$RELEASE_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.+~-]*$ ]] || fail_now "版本目录无效"; fi

# ───────────────────────── 全局状态 ─────────────────────────
APP_HOME="$HOME_DIR"
RELEASES="$APP_HOME/releases"
UPLOADS="$APP_HOME/uploads"
BACKUPS="$APP_HOME/backups"
SHARED="$APP_HOME/shared"
CURRENT="$APP_HOME/current"
LOCK_DIR="$APP_HOME/.deploy.lock"
LOCK_ACQUIRED=0
OLD_RELEASE=""
OLD_CURRENT_NAME=""   # 脚本部署：升级前的 CURRENT 指向（回滚目标）
NEW_RELEASE=""
TS="$(date +%Y%m%d_%H%M%S)"

cleanup() {
  [ "$LOCK_ACQUIRED" = "1" ] && rm -rf "$LOCK_DIR" 2>/dev/null
  return 0
}
trap cleanup EXIT

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # 锁超过 30 分钟视为残留（上一次异常退出），自动接管
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      warn "检测到过期发布锁，自动清理"
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || fail_now "无法获取发布锁: $LOCK_DIR"
    else
      fail_now "另一个发布正在进行中（如确认卡死请删除 $LOCK_DIR）"
    fi
  fi
  LOCK_ACQUIRED=1
}

# ───────────────────────── 环境检查 ─────────────────────────
check_env() {
  command -v docker >/dev/null 2>&1 || fail_now "服务器未安装 docker"
  docker compose version >/dev/null 2>&1 || fail_now "服务器未安装 Docker Compose V2（需要 docker compose 子命令）"
  command -v unzip >/dev/null 2>&1 || fail_now "服务器未安装 unzip（如 CentOS: yum install -y unzip）"
  command -v sha256sum >/dev/null 2>&1 || fail_now "服务器未安装 sha256sum"
  if [ -n "$HEALTH_URL" ]; then
    command -v curl >/dev/null 2>&1 || fail_now "启用了健康检查但服务器未安装 curl"
  fi
  ok "服务器环境检查通过（docker/compose/unzip 可用）"
}

# 脚本部署环境：不需要 docker，按发布包类型要求 tar 或 unzip
check_env_script() {
  command -v sha256sum >/dev/null 2>&1 || fail_now "服务器未安装 sha256sum"
  case "${PACKAGE,,}" in
    *.tar.gz|*.tgz) command -v tar >/dev/null 2>&1 || fail_now "服务器未安装 tar（.tar.gz 发布包需要）" ;;
    *.zip)          command -v unzip >/dev/null 2>&1 || fail_now "服务器未安装 unzip（.zip 发布包需要）" ;;
    *) fail_now "不支持的发布包类型: $PACKAGE（支持 .tar.gz / .tgz / .zip）" ;;
  esac
  if [ -n "$HEALTH_URL" ]; then
    command -v curl >/dev/null 2>&1 || fail_now "启用了健康检查但服务器未安装 curl"
  fi
  ok "服务器环境检查通过（脚本部署，发布包: $PACKAGE）"
}

# ───────────────────────── 环境引导（脚本部署） ─────────────────────────
# 服务器缺 Java 17 / pg_dump 时自动准备用户态环境（不动系统，产物在 shared/toolbox/ 跨版本共享）：
#   JDK 17：工具箱优先 → 系统 ≥17 直接用 → 从清华 Adoptium 镜像下载 JRE 解压安装
#   pg_dump：工具箱优先 → 系统可用直接用 → 借 postgres:16-alpine 镜像生成 docker 包装脚本
# 导出的 PATH / PG_DUMP 会传给项目升级脚本（backup.sh 认 PG_DUMP 环境变量）。
JRE_MIRROR_BASE='https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jre/x64/linux/'

# 从镜像目录页解析最新 JRE17 tar.gz 完整地址（页面不可达时返回空）
pick_jre_url() {
  local page
  page="$(curl -fsSL --max-time 20 "$JRE_MIRROR_BASE" 2>/dev/null)" || return 0
  printf '%s\n' "$page" | grep -o 'OpenJDK17U-jre_x64_linux_hotspot_[^"<>]*\.tar\.gz' | sort -u | tail -1 \
    | while read -r f; do printf '%s%s\n' "$JRE_MIRROR_BASE" "$f"; done
}

# 取 java 主版本号（-version 首行形如 openjdk version "17.0.2" …；java 8 输出 1.8）
java_major() {
  "$1" -version 2>&1 | head -1 | sed 's/.*"\([0-9][0-9]*\).*/\1/' | grep -o '^[0-9]*' || printf 0
}

bootstrap_env_script() {
  local tb="$SHARED/toolbox" sys_major=0
  if command -v java >/dev/null 2>&1; then sys_major="$(java_major java)"; fi

  # ── Java 17 ──
  if [ -x "$tb/jdk/bin/java" ]; then
    export PATH="$tb/jdk/bin:$PATH"
    log "环境引导：使用工具箱 JDK（$("$tb/jdk/bin/java" -version 2>&1 | head -1)）"
  elif [ "$sys_major" -ge 17 ] 2>/dev/null; then
    log "环境引导：系统 Java 版本满足要求（$sys_major）"
  elif [ "$BOOTSTRAP_JAVA" = "1" ]; then
    log "环境引导：系统 Java ${sys_major:-缺失}，从清华镜像下载 JRE 17 → shared/toolbox/jdk ……"
    local url tmp top
    url="$(pick_jre_url)"
    [ -n "$url" ] || fail_now "环境引导失败：无法解析 JRE 下载地址（镜像不可达？可关闭自动安装改为手工安装）"
    mkdir -p -- "$tb"
    ( cd -- "$APP_HOME" && curl -fSL --connect-timeout 15 -o "uploads/.jre17.tar.gz" "$url" ) \
      || fail_now "环境引导失败：JRE 下载失败（$url）"
    tmp="$tb/.jre-incoming.$$"
    rm -rf -- "$tmp"; mkdir -p -- "$tmp"
    if ! tar -xzf "$APP_HOME/uploads/.jre17.tar.gz" -C "$tmp"; then
      rm -rf -- "$tmp" "$APP_HOME/uploads/.jre17.tar.gz"
      fail_now "环境引导失败：JRE 解压失败"
    fi
    rm -f "$APP_HOME/uploads/.jre17.tar.gz"
    top="$(ls -A -- "$tmp")"
    rm -rf -- "$tb/jdk"
    mv -f -- "$tmp/$top" "$tb/jdk"
    rmdir -- "$tmp" 2>/dev/null || true
    [ -x "$tb/jdk/bin/java" ] || fail_now "环境引导失败：解压后未找到 jdk/bin/java"
    "$tb/jdk/bin/java" -version >/dev/null 2>&1 \
      || fail_now "环境引导失败：toolbox JDK 无法执行（glibc 过旧或架构不符？）"
    export PATH="$tb/jdk/bin:$PATH"
    ok "环境引导：JDK 已安装到 shared/toolbox/jdk（$("$tb/jdk/bin/java" -version 2>&1 | head -1)）"
  else
    log "环境引导：系统 Java ${sys_major:-缺失}（未开启自动安装，跳过）"
  fi

  # ── pg_dump ──
  if [ -x "$tb/bin/pg_dump" ]; then
    export PG_DUMP="$tb/bin/pg_dump"
    log "环境引导：PG_DUMP -> $PG_DUMP（工具箱）"
  elif command -v pg_dump >/dev/null 2>&1; then
    log "环境引导：系统 pg_dump 可用"
  elif [ "$BOOTSTRAP_PGDUMP" = "1" ]; then
    command -v docker >/dev/null 2>&1 || fail_now "环境引导失败：pg_dump 自动安装依赖 docker（未安装或当前用户无权限）"
    docker image inspect postgres:16-alpine >/dev/null 2>&1 \
      || docker pull postgres:16-alpine >/dev/null 2>&1 \
      || fail_now "环境引导失败：postgres:16-alpine 镜像不存在且拉取失败"
    mkdir -p -- "$tb/bin"
    cat > "$tb/bin/pg_dump" <<'WRAP'
#!/usr/bin/env bash
# 工具箱 pg_dump：借 postgres:16-alpine 镜像运行客户端（--network host 使 127.0.0.1 直达宿主机端口）
exec docker run --rm -i --network host -e PGPASSWORD postgres:16-alpine pg_dump "$@"
WRAP
    chmod +x "$tb/bin/pg_dump"
    export PG_DUMP="$tb/bin/pg_dump"
    ok "环境引导：pg_dump 已安装到 shared/toolbox/bin/pg_dump（docker 包装）"
  else
    log "环境引导：系统 pg_dump 缺失（未开启自动安装，跳过）"
  fi
}

# ───────────────────────── 健康检查 ─────────────────────────
# HTTP 健康检查：总时长约 HEALTH_TIMEOUT 秒，每 HEALTH_INTERVAL 秒探测一次
health_http() {
  interval="$HEALTH_INTERVAL"; [ "$interval" -ge 1 ] 2>/dev/null || interval=3
  tries=$(( HEALTH_TIMEOUT / interval )); [ "$tries" -ge 1 ] 2>/dev/null || tries=1
  log "开始健康检查: $HEALTH_URL（最多 ${tries} 次，间隔 ${interval}s）"
  i=0
  while [ "$i" -lt "$tries" ]; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    if [ $((i % 10)) -eq 0 ]; then log "健康检查已尝试 ${i}/${tries} 次…"; fi
    sleep "$interval"
  done
  return 1
}

# Docker 容器状态检查：项目内至少一个容器处于 Running。
# 必须在 release 目录内执行：脚本经 SSH exec 运行时 cwd 是用户主目录，
# 相对路径 COMPOSE_FILE 在主目录下不存在，会误判为「无容器」导致健康检查必然失败
health_docker() {
  local dir="$1"
  if [ -n "$PROJECT_NAME" ]; then
    local deadline=$((SECONDS + HEALTH_TIMEOUT)) ids id state healthy all expected count
    expected=$(cd "$dir" && docker compose -f "$COMPOSE_FILE" config --services | wc -l) || return 1
    while [ "$SECONDS" -le "$deadline" ]; do
      ids=$(cd "$dir" && docker compose -f "$COMPOSE_FILE" ps -a -q) || return 1
      all=1; count=0
      for id in $ids; do
        count=$((count + 1))
        state=$(docker inspect -f '{{.State.Running}}' "$id") || return 1
        healthy=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id") || return 1
        [ "$state" = true ] && { [ "$healthy" = healthy ] || [ "$healthy" = none ]; } || all=0
      done
      if [ "$all" = 1 ] && [ "$count" -ge "$expected" ] && [ "$count" -gt 0 ]; then return 0; fi
      sleep "$HEALTH_INTERVAL"
    done
    return 1
  fi
  total=$(cd "$dir" && docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | wc -l)
  [ "$total" -ge 1 ] || return 1
  for id in $(cd "$dir" && docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null); do
    st=$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || echo "false")
    [ "$st" = "true" ] && return 0
  done
  return 1
}

run_health() {
  local dir="$1"
  if [ -n "$PROJECT_NAME" ]; then health_docker "$dir" || return 1; fi
  if [ -n "$HEALTH_URL" ]; then
    health_http
  else
    health_docker "$dir"
  fi
}

# ───────────────────────── 工具函数 ─────────────────────────
# 切换 current 软链接；兼容历史遗留的实体目录（非软链接）布局
link_current() {
  local target="$1"
  if [ -d "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
    warn "current 为实体目录（非软链接），将移除后重建软链接"
    rm -rf "$CURRENT"
  fi
  ln -sfn "$target" "$CURRENT"
}

# ───────────────────────── 失败回滚 ─────────────────────────
do_rollback() {
  local reason="$1"
  stage rollback
  warn "$reason"
  write_history "failed"
  if [ "$AUTO_ROLLBACK" != "1" ]; then
    err "自动回滚未启用，保留新版本运行状态，请人工确认或使用客户端「回滚」按钮"
    echo "__DEPLOY_FAIL__:${reason}（自动回滚未启用，新版本保持运行）"
    exit 1
  fi
  if [ -n "$NEW_RELEASE" ] && [ -d "$NEW_RELEASE" ]; then
    (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1) || true
  fi
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ]; then
    link_current "$OLD_RELEASE"
    log "已切回旧版本: $(basename "$OLD_RELEASE")，正在启动…"
    (cd "$OLD_RELEASE" && docker compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1) || true
    if run_health "$OLD_RELEASE"; then
      ok "旧版本健康检查通过"
      echo "__DEPLOY_FAIL__:${reason}（已自动回滚到 $(basename "$OLD_RELEASE")）"
    else
      warn "旧版本健康检查未通过，请人工确认"
      echo "__DEPLOY_FAIL__:${reason}（已切回旧版本，但恢复健康检查失败）"
    fi
  else
    echo "__DEPLOY_FAIL__:${reason}（无旧版本可回滚）"
  fi
  exit 1
}

on_signal() { # SSH 连接被客户端取消/断开时触发
  do_rollback "发布被中断（连接断开/取消）"
}
trap on_signal HUP INT TERM

# ───────────────────────── 备份 ─────────────────────────
backup_code() {
  stage backup-code
  if [ "$BACKUP_CODE" != "1" ]; then warn "已跳过代码备份"; return 0; fi
  if [ -z "$OLD_RELEASE" ] || [ ! -d "$OLD_RELEASE" ]; then
    warn "无当前运行版本，跳过代码备份"
    return 0
  fi
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/app_${TS}.tar.gz"
  tar -czf "$out" -C "$OLD_RELEASE" . 2>/dev/null || fail_rollback "代码备份失败: $out"
  ok "当前版本已备份: $out"
}

backup_db() {
  stage backup-db
  if [ "$BACKUP_DB" != "1" ]; then return 0; fi
  [ -n "$DB_CONTAINER" ] || fail_rollback "已启用数据库备份但未配置数据库容器名"
  [ -n "$DB_NAME" ] || fail_rollback "已启用数据库备份但未配置数据库名"
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/db_${TS}.sql"
  case "$DB_TYPE" in
    postgres)
      docker exec "$DB_CONTAINER" pg_dump -U "${DB_USER:-postgres}" "$DB_NAME" > "$out" \
        || fail_rollback "PostgreSQL 备份失败（容器: $DB_CONTAINER 库: $DB_NAME）"
      ;;
    mysql)
      if [ -n "$DB_USER" ]; then
        docker exec "$DB_CONTAINER" mysqldump -u"$DB_USER" "$DB_NAME" > "$out" \
          || fail_rollback "MySQL 备份失败（容器: $DB_CONTAINER 库: $DB_NAME）"
      else
        # 未配置用户时使用容器内 MYSQL_ROOT_PASSWORD 环境变量
        docker exec "$DB_CONTAINER" sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" "$0"' "$DB_NAME" > "$out" \
          || fail_rollback "MySQL 备份失败（容器: $DB_CONTAINER 库: $DB_NAME）"
      fi
      ;;
    *) fail_rollback "不支持的数据库类型: $DB_TYPE" ;;
  esac
  ok "数据库已备份: $out"
}

# 备份阶段失败：尚未改动运行状态，直接失败退出
fail_rollback() {
  err "$1"
  echo "__DEPLOY_FAIL__:$1"
  exit 1
}

# ───────────────────────── 清理 ─────────────────────────
cleanup_releases() {
  # 按 mtime 保留最近 KEEP_RELEASES 个版本，当前运行的版本永不删除
  [ -d "$RELEASES" ] || return 0
  local keep_current
  keep_current=$(basename "$(readlink -f "$CURRENT" 2>/dev/null || echo)" 2>/dev/null || echo "")
  local count=0 victim
  ls -1t "$RELEASES" 2>/dev/null | while read -r victim; do
    count=$((count + 1))
    [ "$count" -le "$KEEP_RELEASES" ] && continue
    [ "$victim" = "$keep_current" ] && continue
    rm -rf "$RELEASES/$victim"
    log "清理旧版本: $victim"
  done
}

cleanup_backups() {
  [ -d "$BACKUPS" ] || return 0
  # 代码备份与数据库备份分别保留 KEEP_BACKUPS 份
  ls -1t "$BACKUPS"/app_*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
    rm -f "$f"; log "清理旧代码备份: $(basename "$f")"
  done
  ls -1t "$BACKUPS"/db_*.sql 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
    rm -f "$f"; log "清理旧数据库备份: $(basename "$f")"
  done
}

write_history() {
  # 服务器端简易历史（JSONL），客户端另有完整发布历史
  mkdir -p "$APP_HOME"
  printf '{"version":"%s","status":"%s","time":"%s"}\n' \
    "${VERSION:-unknown}" "$1" "$(date '+%Y-%m-%d %H:%M:%S')" \
    >> "$APP_HOME/deploy-history.jsonl" 2>/dev/null
}

# ═════════════════════════ 脚本部署（script 形态） ═════════════════════════
# 面向「项目自带运维脚本」的部署形态（如单 jar + upgrade.sh/start.sh/stop.sh）：
#   版本管理由项目自身负责（releases/<dir> + CURRENT 指针文件，内容 = release 目录名），
#   备份/停旧/切指针/启动/健康/回滚收敛在发布包内的升级脚本（默认 upgrade.sh）。
# 本脚本职责收敛为：校验上传包 → 解压到 releases/ → 以 INSTALL_ROOT 调升级脚本 →
#   （可选）HTTP 健康复查（失败回滚）→ 清理旧版本。

# CURRENT 指针文件原子切换（写临时文件 + mv，与项目脚本同一约定）
set_current() {
  printf '%s\n' "$1" > "$APP_HOME/CURRENT.tmp.$$"
  mv -f -- "$APP_HOME/CURRENT.tmp.$$" "$APP_HOME/CURRENT"
}
get_current() {
  tr -d '[:space:]' 2>/dev/null < "$APP_HOME/CURRENT" || true
}

# 在指定 release 目录内执行脚本（存在才执行；返回实际退出码，缺文件返回 0）
run_release_script() {
  local dir="$1" script="$2"
  [ -f "$dir/$script" ] || return 0
  ( cd "$dir" && INSTALL_ROOT="$APP_HOME" bash "./$script" )
}

# 脚本部署回滚：停新版本 → CURRENT 切回旧版本并重启（旧版本缺失时尽力而为）
do_rollback_script() {
  local reason="$1" old="$OLD_CURRENT_NAME" new
  new="$(get_current)"
  stage rollback
  warn "$reason"
  write_history "failed"
  if [ "$AUTO_ROLLBACK" != "1" ]; then
    err "自动回滚未启用，新版本保持运行，请人工确认"
    echo "__DEPLOY_FAIL__:${reason}（自动回滚未启用）"
    exit 1
  fi
  if [ -n "$new" ] && [ -f "$RELEASES/$new/stop.sh" ]; then
    ( cd "$RELEASES/$new" && INSTALL_ROOT="$APP_HOME" bash ./stop.sh ) >/dev/null 2>&1 || true
  fi
  if [ -n "$old" ] && [ -d "$RELEASES/$old" ]; then
    set_current "$old"
    log "CURRENT 切回旧版本: $old，正在重启…"
    if run_release_script "$RELEASES/$old" start.sh >/dev/null 2>&1 && { [ -z "$HEALTH_URL" ] || health_http; }; then
      echo "__DEPLOY_FAIL__:${reason}（已自动回滚到 $old）"
    else
      echo "__DEPLOY_FAIL__:${reason}（已切回旧版本，但恢复启动或健康检查失败）"
    fi
  else
    echo "__DEPLOY_FAIL__:${reason}（无旧版本可回滚，新版本已停止）"
  fi
  exit 1
}

# 脚本部署清理：按 mtime 保留最近 KEEP_RELEASES 个 release，CURRENT 指向的永不删除
cleanup_releases_script() {
  [ -d "$RELEASES" ] || return 0
  local keep count=0 victim
  keep="$(get_current)"
  ls -1t "$RELEASES" 2>/dev/null | while read -r victim; do
    count=$((count + 1))
    [ "$count" -le "$KEEP_RELEASES" ] && continue
    [ "$victim" = "$keep" ] && continue
    rm -rf "$RELEASES/$victim"
    log "清理旧版本: $victim"
  done
}

do_deploy_script() {
  [ -n "$APP_NAME" ] || fail_now "缺少 --app"
  [ -n "$HOME_DIR" ] || fail_now "缺少 --home"
  [ -n "$VERSION" ]  || fail_now "缺少 --version"
  [ -n "$PACKAGE" ]  || fail_now "缺少 --package"

  mkdir -p "$RELEASES" "$UPLOADS" "$BACKUPS" "$SHARED"
  [ -w "$APP_HOME" ] || fail_now "部署目录不可写: $APP_HOME"
  acquire_lock
  check_env_script

  # 校验上传包
  local pkg="$UPLOADS/$PACKAGE"
  [ -f "$pkg" ] || fail_now "发布包不存在: $pkg"
  if [ -n "$SHA256" ]; then
    local remote_sha
    remote_sha=$(sha256sum "$pkg" | awk '{print $1}')
    [ "$remote_sha" = "$SHA256" ] || fail_now "发布包校验失败（期望 $SHA256 实际 $remote_sha）"
    ok "发布包 SHA256 校验通过"
  fi

  OLD_CURRENT_NAME="$(get_current)"
  [ -n "$OLD_CURRENT_NAME" ] && log "当前运行版本目录: $OLD_CURRENT_NAME" || log "首次部署，无旧版本"

  # 解压到暂存目录，要求单一顶层目录（发布包结构约定）
  stage extract
  local incoming="$RELEASES/.incoming.$$" entries n
  rm -rf -- "$incoming"
  mkdir -p -- "$incoming"
  case "${PACKAGE,,}" in
    *.tar.gz|*.tgz) tar -xzf "$pkg" -C "$incoming" || { rm -rf -- "$incoming"; fail_rollback "解压失败: $pkg"; } ;;
    *.zip)          unzip -q -o "$pkg" -d "$incoming" || { rm -rf -- "$incoming"; fail_rollback "解压失败: $pkg"; } ;;
  esac
  entries=$(ls -A -- "$incoming")
  n=$(printf '%s\n' "$entries" | grep -c . || true)
  if [ "$n" != "1" ] || [ ! -d "$incoming/$entries" ]; then
    rm -rf -- "$incoming"
    fail_rollback "发布包必须只含一个顶层目录（实际 ${n} 项）"
  fi
  NEW_RELEASE="$RELEASES/$entries"
  # 同版本守卫：线上正运行同一 release 目录时，继续会删除并覆盖运行中版本，
  # 项目升级脚本也会拒绝重复升级——在改动任何服务器状态前直接失败
  if [ -n "$OLD_CURRENT_NAME" ] && [ "$OLD_CURRENT_NAME" = "$entries" ]; then
    rm -rf -- "$incoming"
    fail_now "线上已运行同一版本目录（releases/$entries），重复发布同一发布包无意义，请重新打包生成新版本发布包"
  fi
  rm -rf -- "$NEW_RELEASE"
  mv -f -- "$incoming/$entries" "$NEW_RELEASE"
  rmdir -- "$incoming" 2>/dev/null || true
  chmod +x "$NEW_RELEASE"/*.sh 2>/dev/null || true
  ok "新版本已解压: releases/$entries"
  [ -f "$NEW_RELEASE/$UPGRADE_SCRIPT" ] || fail_rollback "发布包缺少升级脚本: $UPGRADE_SCRIPT"
  [ -f "$NEW_RELEASE/start.sh" ] || fail_rollback "发布包缺少 start.sh（回滚依赖）"

  # 环境引导：调项目升级脚本前就绪 java/pg_dump（升级脚本与失败兜底都依赖）
  bootstrap_env_script

  # 备份/停旧/切指针/启动/健康检查/失败回滚 均由项目升级脚本负责
  stage start
  log "执行升级脚本 $UPGRADE_SCRIPT（INSTALL_ROOT=$APP_HOME）…"
  local uprc=0 cur
  ( cd "$NEW_RELEASE" && INSTALL_ROOT="$APP_HOME" bash "./$UPGRADE_SCRIPT" ) || uprc=$?
  if [ "$uprc" -ne 0 ]; then
    err "升级脚本执行失败（退出码 $uprc）"
    # 升级脚本可能已自行回滚；这里再按 CURRENT 幂等拉起一次当前版本兜底
    cur="$(get_current)"
    if [ -n "$cur" ] && [ -f "$RELEASES/$cur/start.sh" ]; then
      log "尽力恢复当前版本 $cur ……"
      run_release_script "$RELEASES/$cur" start.sh >/dev/null 2>&1 || true
    fi
    write_history "failed"
    echo "__DEPLOY_FAIL__:升级脚本执行失败（详见日志；已尽力恢复 CURRENT 指向的版本）"
    exit 1
  fi
  ok "升级脚本执行完成: releases/$entries"

  # 可选 HTTP 健康复查（升级脚本内部已有健康检查；配置了地址时再确认一次）
  if [ -n "$HEALTH_URL" ]; then
    stage health
    if health_http; then ok "健康检查通过: $HEALTH_URL"
    else do_rollback_script "健康检查失败: $HEALTH_URL"; fi
  fi

  # 版本指针：本工具是 CURRENT 的负责人（回滚、"线上版本"查询、清理旧版本都读它）。
  # 兼容项目脚本自己也会写 CURRENT 的情况——值都是 release 目录名，重复写等价；
  # 但项目脚本不写时（多数项目）必须由这里补上，否则首次发布后没有任何"当前版本"记录。
  set_current "$entries"
  ok "CURRENT -> $entries"

  cleanup_releases_script
  if [ "$DELETE_UPLOAD" = "1" ]; then
    rm -f "$pkg"
    log "已清理上传包: $PACKAGE"
  fi
  find "$UPLOADS" -maxdepth 1 -name '*.zip' -mmin +60 -delete 2>/dev/null
  find "$UPLOADS" -maxdepth 1 -name '*.tar.gz' -mmin +60 -delete 2>/dev/null
  write_history "success"

  echo "__DEPLOY_OK__:$VERSION"
  exit 0
}

# ═════════════════════════ 子命令: deploy ═════════════════════════
do_deploy() {
  [ -n "$APP_NAME" ] || fail_now "缺少 --app"
  [ -n "$HOME_DIR" ] || fail_now "缺少 --home"
  [ -n "$VERSION" ]  || fail_now "缺少 --version"
  [ -n "$PACKAGE" ]  || fail_now "缺少 --package"

  mkdir -p "$RELEASES" "$UPLOADS" "$BACKUPS" "$SHARED"
  [ -w "$APP_HOME" ] || fail_now "部署目录不可写: $APP_HOME"
  acquire_lock
  check_env

  # 校验上传包（方案 §27 SftpUploader：上传后校验）
  local pkg="$UPLOADS/$PACKAGE"
  [ -f "$pkg" ] || fail_now "发布包不存在: $pkg"
  if [ -n "$SHA256" ]; then
    local remote_sha
    remote_sha=$(sha256sum "$pkg" | awk '{print $1}')
    [ "$remote_sha" = "$SHA256" ] || fail_now "发布包校验失败（期望 $SHA256 实际 $remote_sha）"
    ok "发布包 SHA256 校验通过"
  fi

  # 记录旧版本（方案 §11.2）
  OLD_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || echo "")"
  [ -n "$OLD_RELEASE" ] && log "当前运行版本目录: $(basename "$OLD_RELEASE")" || log "首次发布，无旧版本"

  backup_code
  backup_db

  # 解压新版本（方案 §11.4）
  stage extract
  NEW_RELEASE="$RELEASES/${RELEASE_ID:-$VERSION}"
  if [ -n "$OLD_RELEASE" ] && [ "$OLD_RELEASE" = "$NEW_RELEASE" ]; then fail_now "当前版本目录正在运行，请生成新的发布版本"; fi
  rm -rf "$NEW_RELEASE"
  mkdir -p "$NEW_RELEASE"
  unzip -q -o "$pkg" -d "$NEW_RELEASE" || fail_rollback "解压失败: $pkg"
  ok "新版本已解压: releases/$VERSION"

  # 共享配置（方案 §11.5）：.env 由 shared 目录软链，不随版本删除
  if [ -f "$SHARED/.env" ] && [ ! -e "$NEW_RELEASE/.env" ]; then
    if [ -n "$PROJECT_NAME" ]; then cp "$SHARED/.env" "$NEW_RELEASE/.env"; chmod 600 "$NEW_RELEASE/.env"; else ln -s "$SHARED/.env" "$NEW_RELEASE/.env"; fi
    ok "已链接共享配置 shared/.env"
  fi
  # compose 文件在子目录时（如 deploy/docker-compose.yml），
  # docker compose 的变量替换读取该子目录下的 .env，需一并软链
  local compose_dir
  compose_dir="$(dirname "$COMPOSE_FILE")"
  if [ "$compose_dir" != "." ] && [ -f "$SHARED/.env" ] && [ ! -e "$NEW_RELEASE/$compose_dir/.env" ]; then
    mkdir -p "$NEW_RELEASE/$compose_dir"
    ln -s "$SHARED/.env" "$NEW_RELEASE/$compose_dir/.env"
    ok "已链接共享配置到 $compose_dir/.env"
  fi

  # Docker 构建（方案 §12）
  stage build
  (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" config --quiet) || fail_rollback "Compose 配置校验失败"
  log "Docker 镜像构建中（docker compose build）…"
  (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" build) \
    || fail_rollback "Docker 镜像构建失败（旧版本保持运行）"
  ok "Docker 镜像构建完成"

  # 启动服务：先停旧容器释放端口，再启动新版本
  stage start
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ]; then
    log "停止旧版本容器…"
    (cd "$OLD_RELEASE" && docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1) || true
  fi
  (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" up -d) \
    || do_rollback "Docker 服务启动失败"
  ok "Docker 服务已启动"

  # 健康检查（方案 §13）：容器存活 + 业务 HTTP
  stage health
  if [ -z "$HEALTH_URL" ]; then
    if health_docker "$NEW_RELEASE"; then ok "容器状态健康（未配置 HTTP 健康检查）"
    else do_rollback "容器启动状态异常"; fi
  else
    if run_health "$NEW_RELEASE"; then ok "健康检查通过: $HEALTH_URL"
    else do_rollback "健康检查失败: $HEALTH_URL"; fi
  fi

  # 切换 current 软链接 → 新版本生效
  link_current "$NEW_RELEASE"
  ok "current -> releases/$VERSION"

  cleanup_releases
  cleanup_backups
  if [ "$DELETE_UPLOAD" = "1" ]; then
    rm -f "$pkg"
    log "已清理上传包: $PACKAGE"
  fi
  # 顺带清理历史失败遗留的上传包（1 小时前的旧 zip）
  find "$UPLOADS" -maxdepth 1 -name '*.zip' -mmin +60 -delete 2>/dev/null
  write_history "success"

  echo "__DEPLOY_OK__:$VERSION"
  exit 0
}

# ═════════════════════════ 子命令: rollback ═════════════════════════
do_rollback_cmd() {
  [ -n "$HOME_DIR" ] || fail_now "缺少 --home"
  [ -n "$VERSION" ]  || fail_now "缺少 --version"

  [ -d "$RELEASES/$VERSION" ] || fail_now "目标版本不存在: releases/$VERSION"
  acquire_lock

  local target="$RELEASES/$VERSION"
  OLD_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || echo "")"
  NEW_RELEASE="" # 手动回滚无需再回滚

  stage start
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ] && [ "$OLD_RELEASE" != "$(readlink -f "$target")" ]; then
    log "停止当前版本容器…"
    (cd "$OLD_RELEASE" && docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1) || true
  fi
  link_current "$target"
  log "current -> releases/$VERSION，正在启动…"
  (cd "$target" && docker compose -f "$COMPOSE_FILE" up -d) \
    || fail_now "目标版本启动失败: releases/$VERSION"

  stage health
  if [ -n "$HEALTH_URL" ]; then
    run_health "$target" || fail_now "回滚后健康检查失败: $HEALTH_URL"
  else
    health_docker "$target" || fail_now "回滚后容器状态异常"
  fi
  ok "回滚完成，当前版本: $VERSION"
  write_history "rollback"

  echo "__DEPLOY_OK__:$VERSION"
  exit 0
}

# ═════════════════════════ 子命令: rollback（脚本部署） ═════════════════════════
# --version 传 release 目录名；停当前版本 → CURRENT 切目标 → 启动目标并健康检查
do_rollback_cmd_script() {
  [ -n "$HOME_DIR" ] || fail_now "缺少 --home"
  [ -n "$VERSION" ]  || fail_now "缺少 --version"
  [ -d "$RELEASES/$VERSION" ] || fail_now "目标版本不存在: releases/$VERSION"
  [ -f "$RELEASES/$VERSION/start.sh" ] || fail_now "目标版本缺少 start.sh"
  acquire_lock
  bootstrap_env_script

  local target="$RELEASES/$VERSION" cur
  cur="$(get_current)"

  stage start
  if [ -n "$cur" ] && [ "$cur" != "$VERSION" ] && [ -f "$RELEASES/$cur/stop.sh" ]; then
    log "停止当前版本 $cur ……"
    ( cd "$RELEASES/$cur" && INSTALL_ROOT="$APP_HOME" bash ./stop.sh ) || log "旧服务停止返回非零，继续"
  fi
  set_current "$VERSION"
  log "CURRENT -> $VERSION，正在启动…"
  if ! run_release_script "$target" start.sh; then
    err "目标版本启动失败，CURRENT 切回 $cur"
    [ -n "$cur" ] && set_current "$cur"
    [ -n "$cur" ] && run_release_script "$RELEASES/$cur" start.sh >/dev/null 2>&1 || true
    fail_now "回滚启动失败: releases/$VERSION（已恢复指向 $cur）"
  fi

  if [ -n "$HEALTH_URL" ]; then
    stage health
    health_http || fail_now "回滚后健康检查失败: $HEALTH_URL"
  fi
  ok "回滚完成，当前版本: $VERSION"
  write_history "rollback"

  echo "__DEPLOY_OK__:$VERSION"
  exit 0
}

case "$CMD" in
  deploy)   if [ "$MODE" = "script" ]; then do_deploy_script; else do_deploy; fi ;;
  rollback) if [ "$MODE" = "script" ]; then do_rollback_cmd_script; else do_rollback_cmd; fi ;;
  *) fail_now "未知子命令: $CMD（支持 deploy / rollback）" ;;
esac
