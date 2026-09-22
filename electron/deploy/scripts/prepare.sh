#!/usr/bin/env bash
# 自动发布的基础环境准备；复用现有 Docker，不改防火墙、不清理其他服务。
set -euo pipefail
admin() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}
if [ "$(uname -s)" != Linux ]; then echo '[ERROR] 正式服务器需要 Linux'; exit 1; fi
need_install=0
for tool in curl unzip sha256sum; do command -v "$tool" >/dev/null || need_install=1; done
command -v docker >/dev/null || need_install=1
docker compose version >/dev/null 2>&1 || need_install=1
if [ "$need_install" = 1 ]; then
  [ "$(id -u)" = 0 ] || sudo -n true || { echo '[ERROR] 首次准备需要 root 或免密 sudo'; exit 1; }
  . /etc/os-release
  case "$ID" in
    ubuntu|debian)
      admin env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      admin env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl unzip coreutils
      if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
        admin install -m 0755 -d /etc/apt/keyrings
        key=$(mktemp)
        trap 'rm -f "$key"' EXIT
        curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$key"
        admin install -m 0644 "$key" /etc/apt/keyrings/onedeploy-docker.asc
        printf 'deb [arch=%s signed-by=/etc/apt/keyrings/onedeploy-docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" | admin tee /etc/apt/sources.list.d/onedeploy-docker.list >/dev/null
        admin env DEBIAN_FRONTEND=noninteractive apt-get update -qq
        if command -v docker >/dev/null; then
          admin env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin docker-buildx-plugin
        else
          admin env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
        fi
      fi
      ;;
    *) echo "[ERROR] $ID 缺少运行环境，自动安装目前支持 Ubuntu/Debian；已有 Docker Compose 的其他 Linux 可直接发布"; exit 1 ;;
  esac
fi
if ! docker info >/dev/null 2>&1; then
  if ! admin docker info >/dev/null 2>&1; then admin systemctl start docker; fi
  admin docker info >/dev/null
  if [ "$(id -u)" != 0 ]; then echo '__USE_SUDO__'; fi
fi
docker compose version >/dev/null
echo '[OK] 正式服务器运行环境已就绪'
