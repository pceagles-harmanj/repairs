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
| Tech app | `http://repairs.internal.pceagles.org:8080` |
| Student site | `http://repairs.internal.pceagles.org:8081` |
| BIND server | `192.168.10.50` |
| NAS share | `//192.168.10.20/backups/repairs` |

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

## 8. Google OAuth and AfterShip

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
will not have this, which is another argument for a certificate eventually — at
which point set `TLS_CERT_PATH`/`TLS_KEY_PATH` and change the URLs to `https`.

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
