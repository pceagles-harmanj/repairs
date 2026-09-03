#!/usr/bin/env bash
#
# Get a real Let's Encrypt certificate for an INTERNAL hostname.
#
# The trick: the DNS-01 challenge proves you control the name by publishing a
# TXT record. Let's Encrypt never connects to the server, so this works fine for
# a name that resolves to 192.168.10.60 and is not reachable from the internet.
# No port forward, no exposure.
#
# Network Solutions has no DNS API that acme.sh can drive, so we use acme.sh's
# "challenge alias" mode: one CNAME at the registrar, created once by hand,
# points the challenge label at a zone that DOES have an API. After that,
# renewals never touch the registrar again.
#
#   Run on the LXC (the Docker host), as root:
#     ./tls-letsencrypt.sh setup     # one-time: install acme.sh, issue, install
#     ./tls-letsencrypt.sh renew     # force a renewal now (a test, mostly)
#     ./tls-letsencrypt.sh status    # what is on disk and when it expires
#
set -euo pipefail

# ---- edit these -------------------------------------------------------------
DOMAIN="${DOMAIN:-repairs.internal.pceagles.org}"

# The zone that answers the challenge. Create this ONCE at Network Solutions:
#   _acme-challenge.repairs.internal.pceagles.org.  CNAME  _acme-challenge.ALIAS_DOMAIN.
# ALIAS_DOMAIN is a zone you host somewhere with an API (Cloudflare is free),
# or an acme-dns registration. Leave empty only if your registrar has an API.
ALIAS_DOMAIN="${ALIAS_DOMAIN:-acme.pceagles.org}"

# acme.sh DNS plugin for wherever ALIAS_DOMAIN lives.
#   dns_cf       Cloudflare  -> export CF_Token=... CF_Account_ID=...
#   dns_acmedns  acme-dns    -> export ACMEDNS_BASE_URL / ACMEDNS_USERNAME / ...
DNS_PROVIDER="${DNS_PROVIDER:-dns_cf}"

CERT_DIR="${CERT_DIR:-/etc/repairs-tls}"
ACCOUNT_EMAIL="${ACCOUNT_EMAIL:-harmanj@pceagles.org}"
RELOAD_CMD="${RELOAD_CMD:-cd /opt/repairs && docker compose -f deploy/docker-compose.prod.yml restart}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
# -----------------------------------------------------------------------------

ACME="$ACME_HOME/acme.sh"

need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run this as root." >&2; exit 1; }; }

install_acme() {
  if [ -x "$ACME" ]; then echo "==> acme.sh already installed"; return; fi
  echo "==> installing acme.sh"
  command -v curl >/dev/null || { apt-get update -qq && apt-get install -y curl; }
  curl -fsS https://get.acme.sh | sh -s email="$ACCOUNT_EMAIL"
  # acme.sh installs its own daily cron entry; renewal is hands-off from here.
}

check_alias_cname() {
  [ -n "$ALIAS_DOMAIN" ] || return 0
  local want="_acme-challenge.${ALIAS_DOMAIN}"
  local label="_acme-challenge.${DOMAIN}"
  echo "==> checking the one-time CNAME"
  local got
  got="$(dig +short CNAME "$label" 2>/dev/null | sed 's/\.$//')" || true
  if [ -z "$got" ]; then
    cat <<EOF

!! $label has no CNAME yet.

   Create this ONE record at your registrar, then re-run:

     Name:  _acme-challenge.repairs.internal
     Type:  CNAME
     Value: ${want}.

   That label exists only for certificate validation. It cannot affect mail,
   the website, or anything else in pceagles.org.

EOF
    exit 1
  fi
  echo "    $label -> $got"
}

issue() {
  local alias_args=()
  [ -n "$ALIAS_DOMAIN" ] && alias_args=(--challenge-alias "$ALIAS_DOMAIN")

  echo "==> issuing a certificate for $DOMAIN via $DNS_PROVIDER"
  "$ACME" --issue --dns "$DNS_PROVIDER" -d "$DOMAIN" "${alias_args[@]}" \
    --keylength ec-256 --server letsencrypt

  mkdir -p "$CERT_DIR"
  chmod 750 "$CERT_DIR"

  # --install-cert is the supported way to place files: acme.sh re-runs this
  # copy and the reload command on every future renewal, so nothing else has to
  # know where its internal storage lives.
  echo "==> installing to $CERT_DIR"
  "$ACME" --install-cert -d "$DOMAIN" --ecc \
    --fullchain-file "$CERT_DIR/fullchain.pem" \
    --key-file       "$CERT_DIR/privkey.pem" \
    --reloadcmd      "$RELOAD_CMD"

  chmod 640 "$CERT_DIR"/*.pem
  echo
  echo "==> put these in .env, then restart:"
  echo "    TLS_CERT_PATH=$CERT_DIR/fullchain.pem"
  echo "    TLS_KEY_PATH=$CERT_DIR/privkey.pem"
  echo "    PUBLIC_SITE_URL=https://$DOMAIN"
  echo "    PUBLIC_TLS_REDIRECT_HTTP_PORT=8081   # keeps old emailed links alive"
}

case "${1:-setup}" in
  setup)
    need_root
    install_acme
    check_alias_cname
    issue
    ;;
  renew)
    need_root
    "$ACME" --renew -d "$DOMAIN" --ecc --force
    ;;
  status)
    "$ACME" --list || true
    echo
    if [ -f "$CERT_DIR/fullchain.pem" ]; then
      echo "==> $CERT_DIR/fullchain.pem"
      openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -issuer -enddate
    else
      echo "!! no certificate at $CERT_DIR/fullchain.pem yet"
    fi
    ;;
  *)
    echo "usage: $0 setup|renew|status" >&2
    exit 2
    ;;
esac
