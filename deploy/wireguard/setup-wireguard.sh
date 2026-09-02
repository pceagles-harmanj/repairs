#!/usr/bin/env bash
# Generates keys and drops a filled-in wg0.conf into place on one campus gateway.
#
#   sudo ./setup-wireguard.sh a          # on the campus A gateway (listens)
#   sudo ./setup-wireguard.sh b          # on the campus B gateway (dials out)
#
# Run side A first: it prints the public key and the preshared key that side B
# needs. Nothing here talks to the network - it only writes files - so it is
# safe to run twice.
set -euo pipefail

SIDE="${1:-}"
[[ "$SIDE" == "a" || "$SIDE" == "b" ]] || { echo "usage: $0 a|b" >&2; exit 2; }

# --- edit these five lines to match your sites -------------------------------
LAN_A="10.10.0.0/24"                 # campus A LAN (where the repairs server lives)
LAN_B="10.20.0.0/24"                 # campus B LAN
ENDPOINT_A="wg.pceagles.org:51820"   # campus A public name or IP, and UDP port
TUNNEL_A="10.99.0.1"
TUNNEL_B="10.99.0.2"
# -----------------------------------------------------------------------------

command -v wg >/dev/null || { echo "Installing wireguard..."; apt-get update -qq && apt-get install -y wireguard; }

cd /etc/wireguard
umask 077

[[ -f private.key ]] || wg genkey > private.key
wg pubkey < private.key > public.key
[[ -f preshared.key ]] || wg genpsk > preshared.key

MY_PRIV=$(cat private.key)
MY_PUB=$(cat public.key)
PSK=$(cat preshared.key)

echo
echo "This gateway's public key:  $MY_PUB"
echo "Preshared key (same value on both sides):"
echo "  $PSK"
echo

read -rp "Paste the OTHER campus's public key (blank to fill in later): " PEER_PUB
PEER_PUB="${PEER_PUB:-<PEER_PUBLIC_KEY>}"

if [[ "$SIDE" == "a" ]]; then
  ADDR="$TUNNEL_A/30"; LISTEN="ListenPort = 51820"; ENDPOINT=""
  ALLOWED="$TUNNEL_B/32, $LAN_B"
else
  ADDR="$TUNNEL_B/30"; LISTEN=""; ENDPOINT="Endpoint            = $ENDPOINT_A"
  ALLOWED="$TUNNEL_A/32, $LAN_A"
fi

cat > wg0.conf <<CONF
[Interface]
Address    = $ADDR
$LISTEN
PrivateKey = $MY_PRIV
MTU        = 1420

PostUp   = sysctl -w net.ipv4.ip_forward=1
PostUp   = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT

[Peer]
PublicKey           = $PEER_PUB
PresharedKey        = $PSK
$ENDPOINT
AllowedIPs          = $ALLOWED
PersistentKeepalive = 25
CONF
chmod 600 wg0.conf

echo "Wrote /etc/wireguard/wg0.conf"
echo "Start it with:  systemctl enable --now wg-quick@wg0"
echo "Check it with:  wg show        (a recent handshake means it is up)"
