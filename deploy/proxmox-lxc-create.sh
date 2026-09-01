#!/usr/bin/env bash
# Run this ON THE PROXMOX HOST (shell of the node), not in a container.
#
# Creates an unprivileged Debian 13 LXC that can run Docker: nesting and keyctl
# are the two features Docker needs inside LXC. Everything is a variable up top.
set -euo pipefail

CTID="${CTID:-141}"                       # pick a free container id
HOSTNAME_="${HOSTNAME_:-repairs}"
STORAGE="${STORAGE:-local-lvm}"           # where the rootfs lives
TEMPLATE_STORE="${TEMPLATE_STORE:-local}" # where templates are kept
DISK_GB="${DISK_GB:-12}"
CORES="${CORES:-2}"
RAM_MB="${RAM_MB:-2048}"
BRIDGE="${BRIDGE:-vmbr0}"
IP_CIDR="${IP_CIDR:-192.168.10.60/24}"    # static: DNS will point at this
GATEWAY="${GATEWAY:-192.168.10.1}"
DNS_SERVER="${DNS_SERVER:-192.168.10.50}" # your BIND box
TEMPLATE="${TEMPLATE:-debian-13-standard_13.0-1_amd64.tar.zst}"

echo "==> Refreshing template list"
pveam update >/dev/null || true
if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
  echo "==> Downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORE" "$TEMPLATE"
fi

echo "==> Creating CT $CTID ($HOSTNAME_) at $IP_CIDR"
pct create "$CTID" "${TEMPLATE_STORE}:vztmpl/${TEMPLATE}" \
  --hostname "$HOSTNAME_" \
  --cores "$CORES" --memory "$RAM_MB" --swap 512 \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${IP_CIDR},gw=${GATEWAY}" \
  --nameserver "$DNS_SERVER" \
  --features "nesting=1,keyctl=1" \
  --unprivileged 1 \
  --onboot 1 \
  --start 1

echo "==> Waiting for the network"
sleep 8

echo "==> Installing Docker inside the container"
pct exec "$CTID" -- bash -lc '
  set -e
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git cifs-utils
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker version --format "{{.Server.Version}}"
'

cat <<NEXT

Container $CTID is up at ${IP_CIDR%%/*} with Docker installed.

Next:
  pct enter $CTID
  # then follow deploy/RUNBOOK.md from "3. Get the code onto the box"

If Docker misbehaves inside LXC, the usual causes are nesting/keyctl (set here)
and an old kernel on the host. A 2GB VM is the fallback and needs no features.
NEXT
