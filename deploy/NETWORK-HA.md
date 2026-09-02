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
   CAMPUS A (server)                          CAMPUS B
   10.10.0.0/24                               10.20.0.0/24
        |                                          |
   [ gateway A ] ===== UDP 51820 over WAN ===== [ gateway B ]
   10.99.0.1                                   10.99.0.2
        |
   repairs LXC 10.10.0.50
```

Only campus A needs a port open (UDP 51820). Campus B dials out, so its firewall
needs no inbound rule at all. WireGuard is silent to anything without a valid
key, so that open port does not answer scans.

### What the gateway is

A tiny Debian 12 LXC on the Proxmox host at each campus is enough - 1 vCPU,
512 MB, 2 GB disk. It needs `nesting=0` but **must** have `/dev/net/tun`:

```bash
# on the Proxmox host, for the gateway container (adjust the CTID)
pct set 200 -features keyctl=1
echo 'lxc.cgroup2.devices.allow: c 10:200 rwm' >> /etc/pve/lxc/200.conf
echo 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file' >> /etc/pve/lxc/200.conf
```

If your firewall appliance already speaks WireGuard (pfSense, OPNsense, UniFi,
MikroTik, Fortigate 7.x), use that instead and skip the container - the keys and
`AllowedIPs` below are the same either way.

### Steps

**1. Campus A gateway**

```bash
apt update && apt install -y wireguard
cd /etc/wireguard
# copy deploy/wireguard/setup-wireguard.sh here, then:
./setup-wireguard.sh a
```

It prints this side's **public key** and the **preshared key**. Write both down.

**2. Campus B gateway**

```bash
apt update && apt install -y wireguard
./setup-wireguard.sh b        # paste campus A's public key when it asks
```

Copy the preshared key from step 1 into `/etc/wireguard/preshared.key` on B
before starting, or edit `PresharedKey` in `wg0.conf` - it has to match.

**3. Give campus A the B key**

Back on A, put B's public key into the `[Peer]` block, then on both:

```bash
systemctl enable --now wg-quick@wg0
wg show
```

A line reading `latest handshake: 40 seconds ago` means the tunnel is up. No
handshake usually means the UDP port is not actually forwarded to gateway A.

**4. Routing - the step people skip**

The tunnel carries traffic, but the *other machines* on each LAN need to know to
send it there. Two ways:

- **Best:** one static route on each campus's main router
  - at campus A: `10.20.0.0/24 via <gateway A LAN IP>`
  - at campus B: `10.10.0.0/24 via <gateway B LAN IP>`
- **Quick and dirty:** skip the routes, and NAT at campus B so its traffic
  arrives looking like the gateway. Add to B's `wg0.conf`:
  `PostUp = iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE`
  This works, but every request in the repairs log then comes from one IP, which
  makes the public site's rate limiting coarser. Prefer the static routes.

**5. Test**

```bash
# from a workstation at campus B
ping 10.10.0.50
curl -I http://10.10.0.50:8080/healthz
```

**6. DNS at campus B**

Campus B's BIND (or DHCP-handed DNS) needs the same name pointing at the same
box - the app builds links from `PUBLIC_SITE_URL`, so the name must be identical
at both sites or the magic links break at one of them.

In Webmin -> BIND DNS Server on campus B's DNS server, create a master zone
`repairs.internal.pceagles.org` with an A record for `@` pointing at
`10.10.0.50`. That is the same shape as the zone you already made at campus A -
zone name is the full host name, record name is `@` or blank.

Then, on that DNS server: `rndc reload` and check from a client:

```bash
dig +short repairs.internal.pceagles.org @<campus B DNS server>
```

**7. Firewall notes**

- Allow campus B's LAN to reach `10.10.0.50` on **8080** (tech UI) and **80**
  (student site). Nothing else needs to cross.
- Do **not** route campus B's whole internet through the tunnel. `AllowedIPs`
  above is deliberately the LAN subnets only, not `0.0.0.0/0`.
- The tunnel is encrypted, which is what makes plain HTTP acceptable between
  campuses. Keep it that way rather than exposing the app to the internet.

### MTU, if pages hang halfway

Symptom: the login page loads, big pages stall. That is MTU. `MTU = 1420` in the
configs suits most connections; on PPPoE try 1380, and test with:

```bash
ping -M do -s 1372 10.10.0.50     # shrink until it stops saying "message too long"
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

The witness must be at campus A with the cluster. Corosync over the WireGuard
tunnel to campus B is a bad idea - it wants sub-millisecond, stable latency, and
a WAN blip will fence your nodes for you.

### Building the cluster

```bash
# on the first node
pvecm create pcs-cluster --link0 10.10.0.11
# on each other node (run on that node, not the first)
pvecm add 10.10.0.11 --link0 10.10.0.12
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

1. WireGuard tunnel + routes + campus B DNS. Campus B can then use the system.
2. Run like that for a term. It is a single host, but it is backed up nightly.
3. When a second host exists: cluster, QDevice, ZFS replication, HA group, and
   the failover test above.
