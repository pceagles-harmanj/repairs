# One server, two campuses - and what redundancy really buys you

You asked for two things that pull in opposite directions, so this splits them:

1. **Now:** both campuses reach one repairs server, over a WireGuard tunnel.
2. **Later:** if that server's host dies, another Proxmox node starts it.

Part 1 is an afternoon. Part 2 needs a second (really a third) Proxmox node, so
it is written as a plan you can execute when the hardware exists.

---

## Part 1 - WireGuard between the campuses

### The shape of it

```
   HS  192.168.10.0/24                        GS  192.168.168.0/24
                                                       |
   repairs LXC ==== UDP 51820 over WAN ==== [ wg gateway 192.168.168.5 ]
   192.168.10.60                                       |
   10.99.0.1 (inside the tunnel)            10.99.0.2  |
                                              GS clients, via a static route

   The tunnel terminates on the repairs container itself, so HS needs no
   separate gateway box. Neither WireGuard box sits inline: each hangs off an
   ordinary switch port and only sees traffic a static route sends it.
```

Only HS needs a port open (UDP 51820). GS dials out, so its firewall
needs no inbound rule at all. WireGuard is silent to anything without a valid
key, so that open port does not answer scans.

### What boxes this needs, and where they sit

**No new hardware.** WireGuard at these speeds is nothing: 1 core, 512 MB RAM,
2 GB disk, and it will saturate your WAN long before it works up a sweat. What
you already have is enough at both campuses.

**Where it physically sits - the part that surprises people.** The WireGuard box
is *not* inline. It plugs into an ordinary switch port, on the LAN, beside the
router - not between the router and the switch. Nothing is re-cabled and no
traffic passes through it until a static route tells it to. That means you can
build and test the whole tunnel during the school day without touching the
production path, and if you unplug the box, the network carries on exactly as
before.

It needs a **static IP** on its campus LAN (or a DHCP reservation), because two
things point at it by address: the port forward at HS, and the static route at
GS.

#### HS: use the repairs container itself

Since only `192.168.10.60` needs to cross the tunnel, the tidiest option is to
terminate the tunnel *on the repairs container*. No second box, no IP
forwarding, and no return route to add - the container is the destination, so it
answers directly.

```bash
# on the Proxmox host, for the repairs container (adjust the CTID)
modprobe wireguard && echo wireguard >> /etc/modules-load.d/modules.conf
pct stop 101
echo 'lxc.cgroup2.devices.allow: c 10:200 rwm' >> /etc/pve/lxc/101.conf
echo 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file' >> /etc/pve/lxc/101.conf
pct start 101
pct exec 101 -- ls -l /dev/net/tun      # must exist before going further
```

The Cipafilter then forwards UDP 51820 to `192.168.10.60` instead of a separate
gateway address, and `AllowedIPs` on the HS side needs only
`10.99.0.2/32, 192.168.168.0/24`.

This also behaves well later: if you build Proxmox HA, the tunnel moves with the
container, because it *is* the container.

**When to use a separate gateway LXC instead:** if you ever want more than the
repairs server reachable from GS. Then build a 512 MB Debian 12 LXC at
`192.168.10.5` with the same two tun lines, and it routes for the whole LAN.
Everything in this document works either way - only the address in the port
forward changes.

**If the LXC fights you** (some kernels refuse `ip link add` for wireguard
inside an unprivileged container), a 512 MB Debian *VM* has its own kernel and
simply works. Not worth debugging an LXC for an hour.

#### GS: the Windows machine will do, but Debian is better

You have three real options, best first:

1. **Wipe the spare Windows box to Debian 12.** If that machine is not already
   doing a job, this is the answer: same OS as everything else here, the setup
   script runs as written, it survives reboots without anyone logging in, and it
   can hold GS's DNS zone too if that is convenient. Any hardware from the last
   fifteen years is oversized for this.
2. **Keep it on Windows.** WireGuard has an official Windows build and it does
   work as a site-to-site router, with two caveats: routing between the tunnel
   and the LAN is off by default and lives in the registry, and a desktop that
   sleeps, gets patched overnight, or waits at a login screen takes the tunnel
   with it. The procedure is in step 2b below.
3. **A Raspberry Pi or thin client.** If the Windows box is spoken for, this is
   a fifty-dollar purpose-built answer that draws a few watts and will move a
   couple of hundred Mbps.

Whatever you pick, GS needs *a* box: every GS device has to reach the repairs
server, so something on the GS LAN has to hold the tunnel for the whole campus.
(The exception: if only two or three staff at GS ever need it, and no students,
install WireGuard on those individual machines and skip the gateway and the
router route entirely. But students clicking emailed links means the whole
campus needs it, so plan for the box.)

#### Or skip the box entirely

If GS's edge firewall already speaks WireGuard (pfSense, OPNsense, UniFi,
MikroTik, Fortigate 7.x, Sophos), configure it there and you need no box at all
on that side - the keys and `AllowedIPs` are identical. Do **not** do this on
the Cipafilter at HS even if it offers it: keeping the tunnel off the filter
means a firmware update or an RMA cannot take the inter-campus link with it.

### Steps

**1. HS - inside the repairs container**

Do the tun-device step from the section above first, then:

```bash
pct enter 101                  # or ssh into the container
apt update && apt install -y wireguard
cd /etc/wireguard
# copy deploy/wireguard/setup-wireguard.sh here, then:
./setup-wireguard.sh hs
```

It prints this side's **public key** and the **preshared key**. Write both down -
GS needs them, and the preshared key must be identical on both ends.

**2a. GS - on Debian (recommended)**

```bash
apt update && apt install -y wireguard
./setup-wireguard.sh gs        # paste HS's public key when it asks
```

Copy the preshared key from step 1 into `/etc/wireguard/preshared.key` on GS
before starting, or edit `PresharedKey` in `wg0.conf` - it has to match.

**2b. GS - on Windows instead**

Works, with three things the installer will not do for you.

1. Install WireGuard for Windows (wireguard.com/install). Choose
   **Add empty tunnel**, which generates a keypair and shows you the public key.
2. Paste in a config built from `deploy/wireguard/wg0-gs.conf.example`, minus
   the Linux-only lines - Windows has no `iptables`, so delete every `PostUp`
   and `PostDown`:

   ```ini
   [Interface]
   PrivateKey = <the key the app generated for you>
   Address    = 10.99.0.2/30
   MTU        = 1420

   [Peer]
   PublicKey           = <HS public key>
   PresharedKey        = <the shared PSK>
   Endpoint            = <HS public IP>:51820
   AllowedIPs          = 10.99.0.1/32, 192.168.10.60/32
   PersistentKeepalive = 25
   ```

3. Turn on routing, which is off by default on Windows and is the reason
   "the tunnel says connected but nothing works":

   ```powershell
   # PowerShell as Administrator, then REBOOT - this one needs it
   Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters' `
     -Name IPEnableRouter -Value 1
   Set-Service -Name RemoteAccess -StartupType Automatic
   Start-Service RemoteAccess
   ```

Then make it survive the school being closed:

- In the WireGuard app, activate the tunnel once. It installs itself as a
  Windows service, so it reconnects on boot with nobody logged in.
- `powercfg /change standby-timeout-ac 0` and `powercfg /h off` - a sleeping
  gateway is an offline campus.
- Set Windows Update to a maintenance window you know about, and expect the
  tunnel to drop for a few minutes on patch Tuesday reboots.
- Windows Firewall: allow inbound on the LAN profile from `192.168.168.0/24`,
  or it will silently drop the forwarded traffic.

If any of that reads as a chore, that is the honest argument for option 1 -
Debian on the same box does all of it with the setup script and never asks
again.

**3. Give HS the GS key**

Back on HS, put the GS public key into the `[Peer]` block, then on both:

```bash
systemctl enable --now wg-quick@wg0
wg show
```

A line reading `latest handshake: 40 seconds ago` means the tunnel is up. No
handshake usually means the UDP port is not actually forwarded to the HS end, or
the preshared keys differ. (On Windows, the app shows the same thing under
`Latest handshake` in the tunnel panel.)

### If the Cipafilter is your edge device (it is, at HS)

The Cipafilter holds the public IP and does the NAT, so the one inbound rule
goes there. Its admin UI puts this under the firewall section - the wording
varies by version (port forwarding, NAT, inbound rules, redirects). If you
cannot find it, this is a one-line support ticket:

> Please add an inbound rule: UDP port 51820 from any source, forwarded to
> 192.168.10.60 port 51820. This is a WireGuard site-to-site tunnel to our
> other campus. No other inbound ports needed.

(That is the repairs server's own address, per the "use the repairs container
itself" option above. If you build a separate gateway LXC instead, use its
address - `192.168.10.5` in the examples.)

Do **not** run the tunnel on the Cipafilter itself even if it offers WireGuard.
Keeping it on the Debian container means a filter firmware update, a policy
change, or an RMA cannot take the inter-campus link down with it, and the config
stays plain text you own.

Note for the compliance conversation: this does not route anyone around the
filter. `AllowedIPs` lists only the two LAN subnets, so the tunnel carries
campus-to-campus traffic only. Web browsing at either campus still exits through
that campus's filter exactly as before.

**4. Routing - the step people skip**

The tunnel carries traffic, but the *other machines* on each LAN need to know to
send it there. Two ways:

- **Best:** one static route on each campus's main router
  - at HS: `192.168.168.0/24 via <the HS gateway LAN IP>`
  - at GS: `192.168.10.0/24 via <the GS gateway LAN IP>`
    (or just `192.168.10.60/32` - see step 7)
- **Quick and dirty:** skip the routes, and NAT at GS so its traffic
  arrives looking like the gateway. Add to GS's `wg0.conf`:
  `PostUp = iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE`
  This works, but every request in the repairs log then comes from one IP, which
  makes the public site's rate limiting coarser. Prefer the static routes.

Why this matters more than it looks: a request from GS arrives at the repairs
server with a source address of `192.168.168.x`. The server replies, hands the reply
to *its* default gateway - the Cipafilter - which has never heard of
`192.168.168.0/24` and sends it out to the internet, where it dies. The tunnel is
up, the ping works one way, and the page hangs. That is asymmetric routing, and
the static route is the fix.

**The smaller version of the same fix.** Only one machine at HS actually
needs to answer GS, so instead of touching the Cipafilter's routing table
you can put a single route on the repairs container:

```bash
# on the repairs LXC (Debian/Ubuntu), persistent across reboots
cat >> /etc/systemd/network/10-gs.network <<'ROUTE'
[Route]
Destination=192.168.168.0/24
Gateway=192.168.10.5
ROUTE
# or, if it uses ifupdown, in /etc/network/interfaces:
#   up ip route add 192.168.168.0/24 via 192.168.10.5
```

Start here. It touches one host you control rather than the appliance the whole
school depends on, and if it goes wrong the blast radius is the repairs server.
Add the campus-wide route on the Cipafilter later, if you ever want other HS
machines reachable from GS.

**5. Test**

```bash
# from a workstation at GS
ping 192.168.10.60
curl -I http://192.168.10.60:8080/healthz
```

**6. DNS at GS - and why it does no routing**

DNS and routing are separate jobs, and it is worth being precise about which one
does what, because the names make it sound like DNS sends traffic somewhere:

- **DNS answers a question.** A GS laptop asks "what is
  repairs.internal.pceagles.org?" and GS's DNS server says "192.168.10.60".
  That is the whole transaction. No packets to the repairs server pass through
  the DNS server, and there is nothing in BIND to point at the tunnel.
- **The routing table sends the packets.** The laptop now wants to reach
  192.168.10.60, looks at its own routes, finds nothing specific, and hands it
  to its default gateway. That gateway needs the route from step 4
  (`192.168.10.0/24` via the GS WireGuard gateway). *That* is what puts the
  traffic in the tunnel.

So GS needs both, and they are independent: DNS without the route resolves the
name and then hangs. The route without DNS works if you type the IP.

GS's BIND (or DHCP-handed DNS) needs the same name pointing at the same
box - the app builds links from `PUBLIC_SITE_URL`, so the name must be identical
at both sites or the magic links break at one of them.

In Webmin -> BIND DNS Server on GS's DNS server, create a master zone
`repairs.internal.pceagles.org` with an A record for `@` pointing at
`192.168.10.60`. That is the same shape as the zone you already made at HS -
zone name is the full host name, record name is `@` or blank.

Then, on that DNS server: `rndc reload` and check from a client:

```bash
dig +short repairs.internal.pceagles.org @<GS DNS server>   # should say 192.168.10.60
ping 192.168.10.60                                          # proves the route
```

The first command failing is a DNS problem. The first succeeding and the second
failing is a routing problem. They are never the same fix.

**The alternative: a conditional forwarder.** Instead of a copy of the zone at
GS, you can tell GS's BIND to forward anything under `internal.pceagles.org` to
the HS DNS server across the tunnel:

```
zone "internal.pceagles.org" {
    type forward;
    forwarders { 192.168.10.10; };   # the HS DNS server
};
```

One source of truth, but internal names stop resolving at GS whenever the tunnel
is down. The static copy above is two lines and changes roughly never, so prefer
it.

### What this means for the Google redirect URL

The OAuth redirect URI stays a single entry -
`http://repairs.internal.pceagles.org/auth/google/callback` - and both campuses
use it unchanged. Nothing per-campus goes in the Google Cloud console.

That works because the redirect is executed by *the student's browser*, not by
Google's servers. Google replies to the browser with "now go here", the browser
resolves the name against whichever DNS its campus gave it, and routes there
itself. Google never resolves or connects to that name, which is why an
internal-only address with a private IP is fine.

The consequence is that the name must be identical at both campuses. Magic
links, prefs links, and this redirect are all built from `PUBLIC_SITE_URL`; if
GS resolved a different hostname, every emailed link would work at one campus
and 404 at the other.

**7. Tunnel one host, not the whole LAN**

`AllowedIPs` is not just a routing rule - WireGuard also uses it as an inbound
filter, and drops any packet arriving from an address the peer is not allowed to
use. So narrowing it is a real security control, not just tidiness. If GS only
ever needs the repairs server, say so:

```ini
# on GS, in the [Peer] block for HS
AllowedIPs = 10.99.0.1/32, 192.168.10.60/32
```

Now GS routes exactly one HS address into the tunnel, and refuses traffic from
any other HS machine. If the GS gateway is ever compromised, the whole of HS is
not one hop away - one host is.

The matching static route at GS shrinks the same way: `192.168.10.60/32` via the
GS WireGuard gateway, instead of the whole `/24`.

**How tight can the HS side go?** By default HS keeps `192.168.168.0/24` in its
peer block, because replies have to find their way back to real GS clients. To
narrow that too, make GS hide behind its gateway - add to GS's `wg0.conf`:

```ini
PostUp = iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE
```

Every GS request then arrives as `10.99.0.2`, so HS can drop to
`AllowedIPs = 10.99.0.2/32` and the route on the repairs container becomes a
single `/32` as well. That is the tightest the tunnel goes.

**The trade-off, and it is a real one.** With that masquerade in place, the
repairs server sees every GS device as one IP address. The student site's rate
limiting keys on the source address, so all of GS would share a single bucket -
one student hammering the lookup form could throttle the building. Without the
masquerade, each device gets its own bucket and the access log is useful.

Recommended: narrow the **destination** (`192.168.10.60/32` at GS), keep GS's
real client addresses (`192.168.168.0/24` at HS), and skip the masquerade. That
is most of the security benefit and none of the cost.

**The maintenance note.** A `/32` tunnel means the day you want a second service
at HS reachable from GS, nothing works until you add it to `AllowedIPs` on
*both* sides and restart the interface. That failure looks like "the tunnel is
up but this one thing won't connect", which is easy to misdiagnose as a firewall
problem. Leave yourself a comment in the config - the examples have one.

**8. Firewall notes**

- Allow GS's LAN to reach `192.168.10.60` on **8080** (tech UI) and **80**
  (student site). Nothing else needs to cross.
- Do **not** route GS's whole internet through the tunnel. `AllowedIPs`
  above is deliberately the LAN subnets only, not `0.0.0.0/0`.
- The tunnel is encrypted, which is what makes plain HTTP acceptable between
  campuses. Keep it that way rather than exposing the app to the internet.

### MTU, if pages hang halfway

Symptom: the login page loads, big pages stall. That is MTU. `MTU = 1420` in the
configs suits most connections; on PPPoE try 1380, and test with:

```bash
ping -M do -s 1372 192.168.10.60     # shrink until it stops saying "message too long"
```

---

## Part 2 - Proxmox HA for the repairs container

### What HA can and cannot do here

The app is SQLite, which is one writer on one filesystem. So HA here means
**"the container restarts on another node within a couple of minutes"**, not
"two copies serve at once". Do not try to run two instances against one database
over NFS/CIFS - SQLite locking over SMB is exactly the failure that broke your
NAS backups.

Expect roughly:

| | Downtime | What is lost |
|---|---|---|
| ZFS replication + HA, 5-minute schedule | 1-3 min | up to 5 min of writes |
| Shared storage (NFS/iSCSI/Ceph) + HA | 1-2 min | nothing |
| Nightly backup restore, no HA | 1-3 hours | up to a day |

### You need three nodes (or two plus a witness)

A two-node cluster cannot tell "the other node died" from "I lost the network",
so Proxmox refuses to fence, and HA does nothing. Options:

- **Three Proxmox hosts** - cleanest.
- **Two hosts + a QDevice** - a Raspberry Pi or any always-on Debian box acting
  as a tiebreaker. This is the cheap answer and it works well:

```bash
# on the witness box
apt install -y corosync-qnetd
# on each Proxmox node
apt install -y corosync-qdevice
# then, from one node
pvecm qdevice setup <witness-ip>
pvecm status        # expect "Qdevice" in the votes list
```

The witness must be at HS with the cluster. Corosync over the WireGuard
tunnel to GS is a bad idea - it wants sub-millisecond, stable latency, and
a WAN blip will fence your nodes for you.

### Building the cluster

```bash
# on the first node
pvecm create pcs-cluster --link0 192.168.10.11
# on each other node (run on that node, not the first)
pvecm add 192.168.10.11 --link0 192.168.10.12
pvecm status
```

Use a dedicated NIC or VLAN for `link0` if you have one, and add `--link1` on a
second network. Corosync losing its only link is the usual cause of a cluster
fencing itself at 3am.

### Storage: pick one

**ZFS replication (no shared storage needed)** - the practical choice for two or
three hosts with local disks:

```bash
# the repairs container must live on a ZFS storage, e.g. local-zfs
pvesr create-local-job 101-0 <other-node> --schedule '*/5' --rate 50
pvesr status
```

Every 5 minutes the container's disk is sent to the other node. On failover it
starts from the last snapshot, so up to 5 minutes of ticket edits vanish. For
this app that is a handful of notes, and the nightly NAS backup still covers the
rest.

**Shared storage (NFS from the NAS, iSCSI, or Ceph)** - zero data loss on
failover, but the storage becomes the thing that must never fail. If the NAS is
already the single point of failure in your rack, this trades one risk for
another. Put the *container disk* on NFS if you go this way; keep the SQLite
file on that same disk, never on a separate SMB share.

### Turning HA on

```bash
# group: which nodes may run it, and which is preferred
ha-manager groupadd repairs --nodes "pve1:2,pve2:1" --restricted 1
# the container itself (101 = the repairs CTID)
ha-manager add ct:101 --group repairs --max_restart 3 --max_relocate 3 --state started
ha-manager status
```

`pve1:2` means pve1 is preferred; it moves back there when pve1 returns.

### Fencing - the part that must work

Proxmox HA fences by watchdog: a node that loses quorum reboots itself after
~60s, so the survivors can safely start its guests. Use the hardware watchdog if
the board has one:

```bash
# /etc/default/pve-ha-manager
WATCHDOG_MODULE=iTCO_wdt        # or ipmi_watchdog on server boards
systemctl restart watchdog-mux
```

Without this it falls back to a software watchdog, which is fine for a lab and
marginal for a server you rely on.

### Test it properly, once

Do this outside school hours, with a ticket open on screen:

1. `ha-manager status` - confirm the container is `started` on pve1.
2. On pve1: `echo c > /proc/sysrq-trigger` (a real, hard kill - not a clean
   shutdown, which just migrates and proves nothing).
3. Watch `ha-manager status` from pve2. The container should be running there
   inside ~2 minutes.
4. Load `http://repairs.internal.pceagles.org:8080/healthz`.
5. Check the last ticket you edited - if the edit is missing, that is your
   replication window, exactly as expected.
6. Power pve1 back on and confirm it migrates home.

A failover you have never tested is a plan, not a safety net.

### What HA does not cover

- **The NAS backup still matters.** HA survives a dead host, not a bad migration,
  a `DELETE` someone regrets, or a corrupted database. Keep the 01:00 job.
- **DNS.** The name points at an IP, and HA keeps the IP with the container, so
  nothing to do - as long as the container has a static IP, not DHCP.
- **Google OAuth.** Nothing is tied to the host. The token lives in the database,
  which moves with the container.

---

## Order of work

1. WireGuard tunnel + routes + GS DNS. GS can then use the system.
2. Run like that for a term. It is a single host, but it is backed up nightly.
3. When a second host exists: cluster, QDevice, ZFS replication, HA group, and
   the failover test above.
