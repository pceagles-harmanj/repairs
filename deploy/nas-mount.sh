#!/usr/bin/env bash
# Mount the NAS share that the nightly backup writes to.
# Run INSIDE the LXC (or on the VM), once. Adjust the four variables.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.20}"
NAS_SHARE="${NAS_SHARE:-backups/repairs}"
MOUNT_POINT="${MOUNT_POINT:-/mnt/nas-repairs}"
CRED_FILE="${CRED_FILE:-/etc/nas-repairs.cred}"

if [ ! -f "$CRED_FILE" ]; then
  echo "Creating $CRED_FILE - enter the NAS credentials"
  read -rp "username: " NAS_USER
  read -rsp "password: " NAS_PASS; echo
  printf 'username=%s\npassword=%s\n' "$NAS_USER" "$NAS_PASS" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
fi

mkdir -p "$MOUNT_POINT"

LINE="//${NAS_HOST}/${NAS_SHARE} ${MOUNT_POINT} cifs credentials=${CRED_FILE},uid=0,gid=0,file_mode=0640,dir_mode=0750,vers=3.0,_netdev,nofail 0 0"
if ! grep -qF "$MOUNT_POINT" /etc/fstab; then
  echo "$LINE" >> /etc/fstab
  echo "==> added to /etc/fstab"
fi

mount -a
echo "==> mounted:"
df -h "$MOUNT_POINT"

# Drop a marker ON THE SHARE. It disappears the moment the share is not mounted,
# which is the one mount test that cannot be fooled by bind mounts or device
# numbers. Set BACKUP_MARKER_FILE=.repairs-nas in .env to have the app check it.
MARKER="${MOUNT_POINT}/.repairs-nas"
if [ ! -f "$MARKER" ]; then
  if touch "$MARKER" 2>/dev/null; then
    echo "==> wrote marker $MARKER (set BACKUP_MARKER_FILE=.repairs-nas in .env)"
  else
    echo "!! could not write $MARKER - is the share read-only?"
  fi
fi

echo
echo "The app writes backups to /backups inside the container, which compose maps"
echo "to $MOUNT_POINT here. If this mount is missing, the nightly job refuses to"
echo "run rather than quietly writing to the container's own disk."
echo
echo "IMPORTANT: if the container was already running, restart it now -"
echo "  a mount made on the host after the container started is invisible inside it."
echo "  docker compose restart      (or: pct reboot <CTID>)"
