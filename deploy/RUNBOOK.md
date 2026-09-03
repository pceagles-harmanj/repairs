# Deploying to Proxmox — runbook

Target: an unprivileged Debian LXC on Proxmox running Docker, serving plain HTTP
on the LAN, with `repairs.internal.pceagles.org` pointed at it by your BIND
server, and nightly backups landing on the NAS.

Nothing is exposed to the internet in this setup. The container needs **outbound**
HTTPS for Google APIs and AfterShip, nothing inbound from outside.

Work through it in order; each step says how to check it worked.

---

## 1. Decide the address

| Thing | Value used in this runbook |
| --- | --- |
| Container IP | `192.168.10.60` (static) |
| Hostname | `repairs.internal.pceagles.org` |
| Tech app | `http://repairs.internal.pceagles.org:7613` |
| Student site | `http://repairs.internal.pceagles.org:80` |
| BIND server | `192.168.10.50` |
| NAS share | `//192.168.10.230/RepairServer` |

Change them in `deploy/proxmox-lxc-create.sh` and `deploy/env.production.example`
if yours differ.

---

## 2. Create the container

On the **Proxmox node shell** (not in a container):

```bash
# copy the script over, or paste it in
CTID=141 IP_CIDR=192.168.10.60/24 GATEWAY=192.168.10.1 DNS_SERVER=192.168.10.50 \
  bash proxmox-lxc-create.sh
```

It creates an unprivileged Debian 13 CT with `nesting=1,keyctl=1` (the two
features Docker needs inside LXC), installs Docker and starts it.

**Check:** `pct exec 141 -- docker run --rm hello-world` prints the hello banner.

If Docker fights you inside LXC, do not spend the afternoon on it — a 2 vCPU /
2 GB Debian VM with the same Docker install is the boring fallback and behaves
identically from step 3 onward.

---

## 3. Get the code onto the box

```bash
pct enter 141
mkdir -p /opt/repairs && cd /opt/repairs
```

Then either:

```bash
# if the project is in git
git clone <your-repo-url> .
```

or copy it from your Mac:

```bash
# from the Mac, in ~/Documents/Code
rsync -av --exclude node_modules --exclude data Repairs/ root@192.168.10.60:/opt/repairs/
```

**Check:** `ls /opt/repairs/src/server.js` exists.

---

## 4. Configure it

```bash
cd /opt/repairs
cp deploy/env.production.example .env
nano .env
```

Fill in, at minimum:

- `APP_PASSWORD` — a shared password for the tech app. Do not skip this.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from your existing OAuth client.
- `OAUTH_REDIRECT_URI=http://repairs.internal.pceagles.org:8080/oauth2/callback`
- `TRACKING_API_KEY` — the AfterShip key (see step 8).
- `LOANER_DIGEST_TO` — where the daily overdue-loaner digest goes.
- `SCHOOL_HOLIDAYS` — your breaks, so due dates skip them.
- Leave `DRY_RUN_EMAIL=true` for the first day.

**Check:** `grep -c '^[A-Z]' .env` returns something like 40.

---

## 5. Mount the NAS

```bash
NAS_HOST=192.168.10.20 NAS_SHARE=backups/repairs bash deploy/nas-mount.sh
```

**Check:** `touch /mnt/nas-repairs/.write-test && rm /mnt/nas-repairs/.write-test`
succeeds. The app refuses to "back up" onto its own disk, so a missing mount
shows up as a failed backup in Settings rather than a silent non-backup.

---

> **Mount the share BEFORE you start the container.** A bind mount is resolved
> once, when the container starts. If you mount the NAS on the host afterwards,
> the container keeps writing into the empty directory that was there at start
> time — the host then hides it under the new mount, so the app reports success
> and the files are nowhere. After any mount change:
> `docker compose -f deploy/docker-compose.prod.yml up -d --force-recreate`.
>
> The app now refuses to write a "backup" that lands on its own filesystem, and
> Settings → Nightly backup shows the target's real state (exists / writable /
> is it a mount point / how many backup files it can see), so this fails loudly
> rather than quietly.

## 5b. When the backup says "/backups is on the same disk as the database"

That message means the app looked at `/backups` and found an ordinary folder on
the container's own disk, not the NAS. Work through it in this order - the first
two commands usually settle it:

```bash
# 1. On the Proxmox host: is the share actually mounted?
findmnt /mnt/nas-repairs
ls -la /mnt/nas-repairs            # backups should be listed here

# 2. In the container: does IT see the mount?
pct exec 101 -- findmnt /backups
pct exec 101 -- ls -la /backups
```

- **Host shows a mount, container does not** - this is the common one. A mount
  made on the host *after* the container started is invisible inside it: the
  container has its own mount namespace and kept the empty directory it saw at
  boot. Fix: `pct reboot 101` (or `docker compose restart` if the bind is
  Docker-side). Nothing else needs changing.
- **Host shows no mount** - the share dropped. A NAS reboot, an expired
  credential, or an SMB session timeout will do it, and `nofail` in fstab means
  boot succeeded quietly without it. Fix: `mount -a` on the host, confirm with
  `findmnt`, then restart the container.
- **Neither shows anything** - the mount was never set up in this container.
  Re-run `deploy/nas-mount.sh` and add the bind mount:
  `pct set 101 -mp0 /mnt/nas-repairs,mp=/backups`.

### Make the next failure diagnose itself

Create a marker file that lives **on the share** and tell the app to look for
it. A device-number check can be fooled by bind mounts; a file that vanishes
with the mount cannot:

```bash
touch /mnt/nas-repairs/.repairs-nas     # on the host, with the share mounted
# then in .env:
BACKUP_MARKER_FILE=.repairs-nas
```

The app now says "the marker file is missing, so the share is not mounted"
instead of inferring it from disk devices. It also remembers what the target
looked like the last time a backup landed, so a later failure can tell you the
share *used to* work and has since been unmounted - with the `findmnt` commands
to confirm it.

### If you would rather the app never touched the NAS

Point `BACKUP_DIR` at a local folder with `BACKUP_ALLOW_SAME_DISK=true`, and
copy to the NAS from the host on a timer:

```bash
# /etc/systemd/system/repairs-backup-sync.service  (host)
[Service]
Type=oneshot
ExecStart=/usr/bin/rsync -a --delete /var/lib/vz/.../backups/ /mnt/nas-repairs/
```

This is more robust - a NAS outage stops the copy, not the backup - but the app
can no longer verify that anything reached the NAS, so watch the timer instead.

---

## 6. Start it

```bash
cd /opt/repairs
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml logs -f --tail 40
```

You should see both listeners, the schedulers arming, and the warnings for
anything left unset:

```
Repair tickets listening on http://0.0.0.0:8080
Public status site listening on http://0.0.0.0:8081
[backup] next run ... -> /backups
[loaners] next reminder pass ...
[tracking] aftership polling every 180m between 6:00 and 21:00
```

**Check:** from another machine, `curl -s http://192.168.10.60:8080/healthz`
returns `{"ok":true,...}`.

The container restarts with the host (`--onboot 1`), and compose restarts the
app unless you stopped it deliberately (`restart: unless-stopped`).

---

### If the build fails on `better-sqlite3`

```
npm error command sh -c node-gyp rebuild
npm error gyp ERR! find Python
```

That is npm failing to download the prebuilt binary and falling back to
compiling from source in an image with no compiler. The Dockerfile in this repo
builds in two stages precisely so this cannot happen: the builder stage installs
`python3 make g++`, compiles, and proves the module loads; the runtime image
copies the finished `node_modules`. If you hit the error above you are building
an older Dockerfile — `git pull` (or re-`rsync`) and build again.

Two related traps worth knowing:

- **`.dockerignore` matters.** Without it, `COPY . .` copies the host's
  `node_modules` over the Linux one built in the image. On a Mac-built checkout
  that means macOS binaries in a Linux container: `invalid ELF header` at
  startup. The repo ships a `.dockerignore` that excludes `node_modules`, `data`
  and `.env`.
- **A stale `package-lock.json`** (written before a dependency was added) makes
  `npm ci` abort. The Dockerfile falls back to `npm install` automatically, but
  for reproducible builds refresh it once on your Mac and copy it over:
  `npm install --package-lock-only`.

To watch a build closely:

```bash
docker compose -f deploy/docker-compose.prod.yml build --progress=plain --no-cache
```

---

## 7. DNS in Webmin

On the BIND box (`192.168.10.50`), in **Webmin → Servers → BIND DNS Server**:

Best option — add to an existing zone you already serve. If you serve
`pceagles.org` internally, add one record there:

| Field | Value |
| --- | --- |
| Name | `repairs.internal` |
| Type | A |
| Address | `192.168.10.60` |

Otherwise create a master zone `internal.pceagles.org` once, and inside it add
an A record named `repairs` → `192.168.10.60`. (A zone named
`repairs.internal.pceagles.org` needs its record at the **apex** — name left
empty — which is the mistake that bit us earlier.)

Then click **Apply Configuration** in the top right. Webmin writes the zone file
but BIND does not load it until you do.

**Check, from a client:**

```bash
dig +short @192.168.10.50 repairs.internal.pceagles.org   # -> 192.168.10.60
dig +short repairs.internal.pceagles.org                  # same, via your normal resolver
curl -s http://repairs.internal.pceagles.org:8080/healthz
```

If the second `dig` is empty while the first works, your clients are not using
that BIND server — add the record on whatever resolver they do use (or a
conditional forwarder for `internal.pceagles.org`).

---

## 8. Google OAuth and carrier tracking

**Google Cloud console → Credentials → your Web client:**

- Authorized redirect URIs: `http://repairs.internal.pceagles.org:8080/oauth2/callback`
- Authorized redirect URIs (student sign-in on the status site):
  `http://repairs.internal.pceagles.org/auth/google/callback`
  (add the port if the site is not on 80, e.g. `...:8081/auth/google/callback`)

Do **not** bother with Authorized JavaScript origins: the status site uses the
redirect flow, not Google's rendered button. The button needs https and Google
rejects http origins outright, which is why an internal site cannot use it.

Then open the app, **Settings → Connect Google**, and sign in with the admin
account. `npm run check-oauth` (or `docker compose exec repairs npm run
check-oauth`) prints the exact string it will send if Google objects.

> Google normally insists on https for anything that is not localhost. You found
> that it accepted this http URI — good. If the *consent screen* later refuses it
> anyway, fall back to `OAUTH_REDIRECT_URI=http://localhost:8080/oauth2/callback`
> and connect once through `ssh -L 8080:192.168.10.60:8080 root@192.168.10.60`
> from your Mac. The refresh token is stored in the database, so it is a one-time
> chore either way.

**AfterShip:** create a free account, generate an API key, put it in
`TRACKING_API_KEY`, restart. Settings → Parcel tracking shows the provider,
the schedule and a **Check all tracking now** button. The free plan covers about
50 shipments a month; the poller only touches open shipments with a tracking
number, never overnight, and never re-checks one that has been received.

---

## 8b. Carrier tracking, without paying for it

`TRACKING_PROVIDER=multi` reads each tracking number, works out which carrier it
belongs to, and calls that carrier's own API. UPS, FedEx and USPS all give
tracking away free, so an aggregator is only worth paying for if parcels arrive
on something none of them cover.

| Carrier | Where to register | What you get |
|---|---|---|
| UPS | developer.ups.com | Client id + secret, OAuth client-credentials |
| FedEx | developer.fedex.com | Client id + secret (a "project"), same flow |
| USPS | developers.usps.com | Consumer key + secret, needs a USPS business account |
| Amazon | nothing to register | No public API - see below |

Set only the carriers you order from. A parcel on a carrier you have not
configured is reported as unpollable rather than as an error.

### Amazon, honestly

There is no free public API for tracking something you bought on Amazon. The
Amazon Shipping API is for merchants who ship *with* Amazon; it does not let a
customer follow their own order. So Amazon Logistics parcels (`TBA...` numbers)
stay manual: the status is whatever a human sets, the tracking link still works,
and the poller marks them unpollable once instead of logging the same error
every three hours.

The useful workaround is a fact about how Amazon ships: a lot of orders go out
via UPS, FedEx or USPS. When they do, paste **that** carrier's number and it
tracks automatically. The number's format decides which API is used, whatever
the vendor field says - so a shipment labelled "Amazon Business" with a `1Z`
number is polled as UPS.

### Checking it works

```bash
# Settings shows which carriers are live; or from the shell inside the container:
docker compose exec repairs node -e "console.log(require('./src/tracking').status())"
```

`carriers_ready` lists the carriers with working credentials. `manual_carriers`
lists the ones that will always need a human.

---

## 9. The plain-HTTP consequences (and the fix)

Browsers treat `http://` origins as insecure, which switches off two things:

- **Camera barcode scanning** (`getUserMedia`)
- **"Install app"** / service worker

Handheld USB scanners are unaffected — they are keyboards.

For a managed fleet, tell Chrome to trust the origin. **Google Admin console →
Devices → Chrome → Settings → Users & browsers** (and the same under *Managed
guest sessions* / *Devices* for Chromebooks), find **"Insecure origins treated
as secure"** — policy `OverrideSecurityRestrictionsOnInsecureOrigin` — and add:

```
http://repairs.internal.pceagles.org:8080
http://repairs.internal.pceagles.org:8081
```

Camera scanning and installability come back on managed devices. Personal phones
will not have this, which is the argument for a certificate — see **§9b**, which
gets you a real Let's Encrypt certificate without exposing anything, after which
these policy entries can be removed.

The scan button no longer hides itself when the camera is unavailable. Pressing
it explains which of the three blocks is in the way — insecure origin, no camera
API, or no built-in barcode reader — and prints the exact origin string to paste
into the policy above. One caveat worth knowing before you chase a bug: Chrome
ships the barcode reader on **ChromeOS, Android and macOS but not on Windows or
Linux desktops**, so a tech on a Windows PC will get the "no built-in barcode
reader" message even after the policy is right. Chromebooks, phones, and
handheld scanners all work.

---

## 9b. Turning on HTTPS (Let's Encrypt, nothing exposed)

You do **not** need Caddy. The app terminates TLS itself - set `TLS_CERT_PATH`
and `TLS_KEY_PATH` and `listen()` serves https instead of http. A reverse proxy
would only add a third thing to keep alive.

You also do **not** need to expose anything. The DNS-01 challenge proves you
control the name by publishing a TXT record, so Let's Encrypt never connects to
`192.168.10.60`. No port forward, no inbound rule.

### The one public DNS record

Network Solutions has no DNS API that acme.sh can drive, so instead of letting
automation touch your real zone, delegate just the challenge label once:

```
Name:  _acme-challenge.repairs.internal
Type:  CNAME
Value: _acme-challenge.acme.pceagles.org.
```

`acme.pceagles.org` is a zone you host somewhere with an API - Cloudflare's free
tier is the usual choice - or an acme-dns registration. Two things worth saying
plainly about this record:

- It is the **only** change you ever make at the registrar. Renewals write TXT
  records in the delegated zone, forever, without touching Network Solutions.
- `_acme-challenge.repairs.internal` exists for certificate validation and
  nothing else. It cannot affect mail, the website, or any other name in
  `pceagles.org`. There is no MX, SPF, or A record involved.

Your internal A record stays exactly as it is: `repairs.internal.pceagles.org`
→ `192.168.10.60`, served by your own BIND at each campus. A public certificate
for a name that only resolves internally is perfectly valid - Let's Encrypt
certifies the *name*, not where it points.

### Issue the certificate

On the LXC (the Docker host), as root:

```bash
cd /opt/repairs
export CF_Token=...            # or the acme-dns variables
./deploy/tls-letsencrypt.sh setup
```

It installs acme.sh, checks that CNAME exists (and prints the record to create
if it does not), issues the certificate with `--challenge-alias`, and installs
it to `/etc/repairs-tls/`. acme.sh adds its own daily cron entry, so renewal at
~60 days is hands-off; `--install-cert` re-copies the files and restarts the
container each time.

### Switch the app over

`docker-compose.prod.yml` already mounts `/etc/repairs-tls` read-only. Uncomment
the TLS port lines, then in `.env`:

```ini
TLS_CERT_PATH=/etc/repairs-tls/fullchain.pem
TLS_KEY_PATH=/etc/repairs-tls/privkey.pem

PUBLIC_URL=https://repairs.internal.pceagles.org:8443
PUBLIC_SITE_URL=https://repairs.internal.pceagles.org
OAUTH_REDIRECT_URI=https://repairs.internal.pceagles.org:8443/oauth2/callback
PUBLIC_OAUTH_REDIRECT_URI=https://repairs.internal.pceagles.org

# Keep the links already sitting in inboxes working.
PUBLIC_TLS_REDIRECT_HTTP_PORT=8081
```

Then map the ports on the host: `443 -> 8443` for the student site (or run it on
8443 directly), and `80 -> 8081` so the redirect listener catches old links.

### Do not forget the two Google entries

Both redirect URIs are registered in the Cloud console and must match the new
scheme exactly, or sign-in breaks with `redirect_uri_mismatch`:

- **Authorized redirect URIs** - add the two `https://` URLs above. Leave the
  old `http://` ones in place until you are sure, then remove them.
- Run `npm run check-oauth` afterwards; it compares .env against what Google
  will accept.

### The links already in people's inboxes

Every magic link emailed so far starts with `http://`. `PUBLIC_TLS_REDIRECT_HTTP_PORT`
starts a listener whose only answer is a 302 to the https origin, keeping the
path and query - so an old link still opens the right ticket.

Two deliberate details in that listener: it redirects to the **configured**
hostname rather than whatever `Host` the request carried (reflecting it would
make the thing an open redirect, and a magic-link URL is precisely what you do
not want bounced elsewhere), and it uses 302 rather than 301, because a
permanent redirect is cached by browsers effectively forever and would be
painful if the certificate ever had to come back out.

### What you get for it

- **Camera barcode scanning and "install app" work with no Chrome policy.** They
  need a secure context, which https simply is. The
  `OverrideSecurityRestrictionsOnInsecureOrigin` entries from §9 can come out.
- **Personal phones on the school wifi** trust it with no warning and nothing to
  install - the reason this beats an internal CA here.
- Passwords and session cookies stop crossing the LAN in the clear.

### Verifying

```bash
# from a workstation
openssl s_client -connect repairs.internal.pceagles.org:443 -servername repairs.internal.pceagles.org </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate
curl -sI http://repairs.internal.pceagles.org/t/test | head -3   # expect 302 to https
./deploy/tls-letsencrypt.sh status
```

If issuance fails, `--debug 2` on the acme.sh command shows the challenge
exchange. The usual cause is the CNAME not having propagated yet - Network
Solutions can take 30+ minutes.

---

## 10. First-day checklist

1. Settings → **Reset to the school templates** (an install that predates the
   themed emails keeps the old wording).
2. Settings → Connect Google, then Devices tab → search a real asset tag.
3. Create a throwaway ticket, watch the email in Settings → Email log while
   `DRY_RUN_EMAIL=true`.
4. Settings → **Back up now**, then check the file landed on the NAS.
5. Loaners tab → **Run the reminder pass now** (dry run) and read what students
   would have received.
6. Flip `DRY_RUN_EMAIL=false`, `docker compose ... up -d`, and send one real
   email to yourself from a test ticket.

---

## The second campus, and surviving a dead host

Both are in **[NETWORK-HA.md](NETWORK-HA.md)**: a WireGuard site-to-site tunnel so
GS reaches this one server (config templates and a setup script live in
`deploy/wireguard/`), and a Proxmox HA plan for when a second host exists.

## Setting the version

The footer on the tech site reads `v0.3.0 · a3f91c2 · built 9/3/2026`. Those
three parts come from three different places.

**The version** lives in `package.json` and is the only one you set by hand:

```bash
npm version minor --no-git-tag-version    # 0.3.0 -> 0.4.0
npm version patch --no-git-tag-version    # 0.3.0 -> 0.3.1
npm version 0.5.0 --no-git-tag-version    # straight to a number
```

Drop `--no-git-tag-version` if you want npm to commit the bump and tag it. Or
just edit the `"version"` line in `package.json` - nothing clever reads it.

**The commit and build date** are build arguments, so they cannot be wrong: they
describe the image, not the source tree it came from. Build with:

```bash
npm run docker:build      # stamps both from git and the clock, then builds
npm run docker:up         # the same, then restarts the container
```

If you build with a bare `docker compose build`, those two are simply blank and
the footer shows `v0.3.0` on its own. That still answers the question the footer
exists for - "is the version I just deployed the one being served, or is my
browser holding a cached app.js".

To check what a running container thinks it is:

```bash
docker compose -f deploy/docker-compose.prod.yml exec repairs npm run version:show
curl -s http://repairs.internal.pceagles.org:8080/api/meta | grep -o '"build":{[^}]*}'
```

## Day-to-day

```bash
cd /opt/repairs
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs --tail 100
docker compose -f deploy/docker-compose.prod.yml restart

# update to a new version
git pull                      # or rsync again from the Mac
docker compose -f deploy/docker-compose.prod.yml up -d --build

# run the tests inside the image
docker compose -f deploy/docker-compose.prod.yml exec repairs npm test
```

**If a backup "succeeds" but nothing appears on the NAS**, check where the app
is actually writing — from inside the container, not from the host:

```bash
cd /opt/repairs
# what the app sees
docker compose -f deploy/docker-compose.prod.yml exec repairs sh -lc \
  'echo BACKUP_DIR=$BACKUP_DIR; ls -la $BACKUP_DIR; df -h $BACKUP_DIR; mount | grep -i cifs'
# what the host sees
ls -la /mnt/nas-repairs; mount | grep nas-repairs
```

Three things to compare:

1. **`BACKUP_DIR` must be the path *inside* the container** — `/backups` with the
   compose file as written. Setting it to the host path (`/mnt/nas-repairs`)
   makes the app create that directory inside the container and write there,
   which looks fine from the app and is invisible on the host.
2. **`df` inside the container should show the NAS**, not the container's
   overlay or root filesystem. If it shows the root filesystem, the share was
   not mounted when the container started.
3. **The host directory must be mounted before the container starts** (see the
   note in step 6).

**`ENOENT` when writing the backup.** SQLite cannot create its backup file directly
on a CIFS share. The app stages the backup on local disk and copies the finished
file across, so this should not happen - if you see it, you are running a build
from before that change. Rebuild.

**Backups.** The nightly job at 01:00 writes `repairs-YYYY-MM-DD_HHMMSS.db.gz`
to the NAS and prunes past `BACKUP_KEEP_DAYS`. To restore: stop the app,
`gunzip` a file over `data/repairs.db`, start it.

**Proxmox snapshots** are a second line of defence, not the first: snapshotting a
running container captures the SQLite file mid-write. The nightly job uses
SQLite's online backup API, which is the safe copy. Take snapshots before
upgrades.

**Where things live.** `/opt/repairs/deploy/data` on the host is the live
database; `/mnt/nas-repairs` is the backup target. Both are bind-mounted, so
`docker compose down` destroys nothing.
