#!/usr/bin/env bash
# Generates keys and drops a filled-in wg0.conf into place on one campus gateway.
#
#   sudo ./setup-wireguard.sh hs        # on the HS gateway (listens)
#   sudo ./setup-wireguard.sh gs        # on the GS gateway (dials out)
#
# Run HS first: it prints the public key and the preshared key that GS needs.
# Nothing here touches the network - it only writes files - so it is safe to
# run twice.
set -euo pipefail

SIDE="${1:-}"
[[ "$SIDE" == "hs" || "$SIDE" == "gs" ]] || { echo "usage: $0 hs|gs" >&2; exit 2; }

# --- check these five lines before running ------------------------------------
LAN_HS="192.168.10.0/24"              # HS LAN (where the repairs server lives)
LAN_GS="192.168.168.0/24"             # GS LAN
ENDPOINT_HS="<HS_PUBLIC_IP>:51820"    # HS public IP or hostname, and UDP port
TUNNEL_HS="10.99.0.1"                 # inside the tunnel only - leave alone
TUNNEL_GS="10.99.0.2"
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
echo "Preshared key (use the SAME value on both sides):"
echo "  $PSK"
echo

read -rp "Paste the OTHER campus's public key (blank to fill in later): " PEER_PUB
PEER_PUB="${PEER_PUB:-<PEER_PUBLIC_KEY>}"

if [[ "$SIDE" == "hs" ]]; then
  ADDR="$TUNNEL_HS/30"; LISTEN="ListenPort = 51820"; ENDPOINT=""
  ALLOWED="$TUNNEL_GS/32, $LAN_GS"
else
  ADDR="$TUNNEL_GS/30"; LISTEN=""; ENDPOINT="Endpoint            = $ENDPOINT_HS"
  ALLOWED="$TUNNEL_HS/32, $LAN_HS"
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
