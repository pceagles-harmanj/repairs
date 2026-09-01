# Repair Tickets

A small, fast repair-ticket system for a Google Workspace shop. Devices come from
Google Admin (asset tag, serial, notes, org unit, most recent user), tickets live in a
local SQLite file, status changes email the device's user through Gmail, and users can
check their own repair - and choose which emails they get - on a separate public page.

- **Backend:** Node + Express + SQLite (`better-sqlite3`, synchronous, sub-millisecond queries)
- **Frontend:** one HTML file, one CSS file, one JS file. No framework, no build step
- **Google:** OAuth browser sign-in (one admin account), Admin SDK Directory + Gmail
- **Emails:** per-ticket subscriptions, editable templates in the school's maroon and gold,
  one-click opt-out, full send log
- **Loaners:** linked to the ticket as real Google devices, found by asset tag (scan or type),
  with school-day due dates, automatic return reminders and a deployed-loaners page
- **Barcodes:** handheld scanners and the device camera, on every asset-tag field
- **Inventory:** parts on hand with bins and reorder points, donor devices, and parts on order
- **Tracking:** shipment status follows the carrier automatically, quietly
- **Phones:** the tech UI is built for a phone at the cart, and installs as an app
- **Two listeners:** the tech app on `PORT` (internal only) and the user-facing site on
  `PUBLIC_SITE_PORT`. Only the second one is meant to be reachable off-network, so the
  ticket API is not merely hidden behind a path check - it is not on that port at all
- **Backups:** SQLite online-backup to your NAS every night at 1 AM, gzipped, pruned

```
Tech app (internal)                     Public site (safe to expose)
  Tickets  queue, filters, search         /t/<token>  this repair's status
  Devices  Google Admin lookups           /u/<token>  which emails you get
  Settings Google, templates, backups      /          sign in / look up a repair
```

---

## 1. Quick start (local)

```bash
cd ~/Documents/Code/Repairs
npm install
cp .env.example .env          # then edit it - see section 2
npm run seed:demo             # optional: fake tickets so you can click around
npm start                     # tech app on :8080, public site on :8081
```

Without Google credentials everything except device lookups and email works, so you can try
both UIs first. Set `DRY_RUN_EMAIL=true` in `.env` while experimenting: emails are rendered
and logged but never sent. To see the user-facing side, open a ticket, look at the bottom of
the "Email notifications" card and click the status-page link.

Run the tests any time with `npm test` (159 tests covering the API, the email rules, per-ticket
subscriptions, the public site, backups, the password gate and the OAuth callback - no network
or Google account needed).

---

## 2. Google Cloud + Workspace setup

You do this once. It takes about ten minutes.

### a. Pick/create a Cloud project and turn on the two APIs

1. Go to <https://console.cloud.google.com/> and select or create a project.
2. **APIs & Services → Library**, then enable:
   - **Admin SDK API** (device and user lookups)
   - **Gmail API** (sending status emails)

### b. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **Internal** (keeps it to your domain and skips Google verification).
3. App name: `Repair Tickets`. Support email: yours. Save.

### c. Create the OAuth client

1. **APIs & Services -> Credentials -> Create credentials -> OAuth client ID**.
2. Application type: **Web application**.
3. Under **Authorized redirect URIs** add the one you will actually use (see the table
   below), for example `https://repairs.internal.pceagles.org/oauth2/callback`.
4. If you want Google sign-in on the public site, also add the public origin under
   **Authorized JavaScript origins** (e.g. `https://repairs.pceagles.org`).
5. Copy the client id and secret into `.env`.

#### Which redirect URI can I use on an internal-only server?

Google validates the *string*, not the DNS: it never resolves the hostname, so an
internal name works - but it must be **https**, and it must be a real domain (no
`.local`, no bare IP address). Three workable setups:

| Setup | Redirect URI | What you need |
| --- | --- | --- |
| **Internal DNS + real cert** (what you described, and the best long-term answer) | `https://repairs.internal.pceagles.org/oauth2/callback` | An A record on your internal DNS pointing at the server, plus a certificate for that name. Let's Encrypt issues one over **DNS-01** without the host being publicly reachable - only a TXT record in the `pceagles.org` zone. Point `TLS_CERT_PATH` / `TLS_KEY_PATH` at the files and Node serves https itself; no nginx required. |
| **Connect over an SSH tunnel** (zero setup, one-time) | `http://localhost:8080/oauth2/callback` | Serve plain http internally. Run `ssh -L 8080:localhost:8080 you@server`, open `http://localhost:8080` on your laptop, connect Google once. The refresh token is then stored in the database and nothing needs localhost again. Set `OAUTH_REDIRECT_URI=http://localhost:8080/oauth2/callback` and leave `PUBLIC_URL` as the address staff actually use. |
| **Public hostname you already own** | `https://repairs.pceagles.org/oauth2/callback` | Only if you are exposing the tech app, which is not recommended. The public *status* site is the thing designed to be exposed. |

`OAUTH_REDIRECT_URI` exists precisely so the redirect and the everyday URL can differ:
Google only ever needs the redirect to match what you registered.

### d. Connect the app

1. `npm start`, open the app, go to **Settings -> Connect Google**.
2. Sign in with an admin account that can (i) read ChromeOS devices and (ii) send mail.
   Super admin works; a custom admin role with *Services -> Chrome Management -> Manage
   ChromeOS Devices* is enough for device reads, and write-back needs the same privilege
   without "read only".
3. The refresh token is stored in your local SQLite database (`settings` table), so you
   only do this once per install. Emails are sent **from that account**, with `Reply-To`
   set to it as well.

The connect flow carries a single-use random `state` value and the callback requires a
signed-in session, so a stray or hostile callback URL cannot swap the connected account.

Scopes requested:

| Scope | Why |
| --- | --- |
| `admin.directory.device.chromeos` | read device details, and write asset tag / user / location / notes |
| `admin.directory.user.readonly` | turn a user email into a display name |
| `gmail.send` | send the status emails |
| `openid email profile` | know which account is connected |

Set `ALLOW_DEVICE_WRITEBACK=false` if you would rather the app never writes to Google Admin.

---

## 3. How the emails work

Notification settings live **on the ticket**, not on the status. Each ticket carries its
own list of statuses that email the device's user:

```
new ticket  ->  list seeded from the templates' "auto-send" switches
                (empty if that address has unsubscribed)
status change -> in the ticket's list?  email goes
                 not in the list?       silent
```

Who can change that list:

- **You**, in the ticket drawer ("Email notifications for this ticket") - tick the
  statuses that matter for this repair, "Uncheck all" for a device nobody needs updates
  about, "Use template defaults" to reset.
- **The user**, from the link at the bottom of every email. Same checkboxes, plus
  "stop all repair emails to this address", which suppresses mail on every ticket they
  have, now and in future. Gmail's own one-click unsubscribe button works too
  (`List-Unsubscribe` / RFC 8058).
- Unsubscribed addresses appear in **Settings -> Unsubscribed addresses**, where you can
  resubscribe someone who asks.

The per-change checkbox in the drawer is still there and is pre-ticked from the ticket's
own list, so the common case is one click and skipping an email is one click. `notify_user`
on a ticket is a hard off switch that beats the list.

You can always send a one-off: pick any template in **Send an email**, edit the subject or
body in place, preview, send. Edits there do not change the saved template. Everything
sent, skipped, dry-run or failed is recorded in `email_log`.

A failed email never blocks the status change; the failure is written to the ticket
timeline so you can retry.

### Notes are internal

Notes on a ticket are internal. `{{latest_note}}` is filled **only** by the note you type
into the box for that specific email or status change - it never reaches back into the
ticket's history. So "bill the family, don't tell the student" stays where you put it, and
the public status page shows status history without note text at all. There is a test for
this (`test/subscriptions.test.js`), because it is the kind of mistake you only make once.

Placeholders available in subject and body:

```
{{ticket_number}} {{status}} {{status_label}} {{priority}}
{{first_name}} {{user_name}} {{user_email}}
{{serial}} {{asset_tag}} {{model}} {{location}} {{loaner_serial}} {{estimated_cost}}
{{issue_category}} {{issue_description}} {{latest_note}} {{assigned_to}}
{{created_at}} {{updated_at}}
{{org_name}} {{helpdesk_name}} {{helpdesk_signature}}
{{status_url}} {{unsubscribe_url}}
```

Values are HTML-escaped when substituted. If a template mentions neither link, a small
footer with both is appended automatically (as long as `PUBLIC_SITE_URL` is set).

Templates also support **conditional sections**, so a template never shows an empty label:

```html
<!--if:latest_note--> ...only rendered when a note was typed... <!--/if-->
```

### The look

The shipped templates are table-based, inline-styled HTML (what email clients actually
render) in the school's maroon and gold: a maroon header band with a gold rule, white card,
gold callout for "ready for pickup", and a quiet footer. Colours come through as
`{{brand_primary}}` and friends, so changing `BRAND_PRIMARY` / `BRAND_ACCENT` in `.env`
re-themes emails that are **already saved in the database** - no re-seeding.

If you edited the templates and want the shipped wording back, use
**Settings → Reset to the school templates** (it keeps your auto-send switches). An install
created before these templates existed keeps its old wording until you press that button.

---

## 3b. The public status site

Runs on `PUBLIC_SITE_PORT` (8081 by default) as a **separate Express app** sharing the same
database. It can read tickets and change email preferences. It cannot touch anything else -
no ticket API, no device data beyond model and asset tag, no notes, no serial numbers.

Three ways a user gets in:

1. **Magic link** - every email carries `/t/<id>.<hmac>`, unguessable and specific to one
   ticket. This is the path to encourage; nothing to remember, works from any network.
2. **Google sign-in** - shows every ticket for that Google account. Requires
   `PUBLIC_GOOGLE_CLIENT_ID` *and* `PUBLIC_ALLOWED_DOMAINS` (it fails closed if the domain
   list is empty, so a stranger's Google account cannot sign in). Google's script does not
   work inside an iframe, so on an embedded page users get the lookup form instead.
3. **Asset tag + email** - both must match the same ticket, rate limited per source
   address. Turn it off with `PUBLIC_ALLOW_LOOKUP=false` if you would rather only use
   magic links.

Changing email preferences always requires proof of ownership: the preferences page has its
own signed token, and a *forwarded status link* only reaches it after typing the address on
the ticket. (Status tokens and preference tokens are signed separately - one cannot be
turned into the other.)

### Exposing it

```
Internet -> your firewall/NAT or reverse proxy -> <server>:8081
```

Set `PUBLIC_SITE_URL` to the address users will see (`https://repairs.pceagles.org`), give
that hostname a certificate (`PUBLIC_TLS_CERT_PATH` / `PUBLIC_TLS_KEY_PATH`, or terminate
TLS at a proxy), and forward only that port. Notes:

- Keep `PUBLIC_TRUST_PROXY=false` when the port is forwarded straight to Node. Turn it on
  only behind a proxy you control, otherwise `X-Forwarded-For` is attacker-supplied and the
  rate limiter can be sidestepped.
- The tech app on `PORT` should stay on the LAN. There is no reason to forward it.
- Everything the public site serves is server-rendered HTML with a strict CSP; the only
  external script allowed is Google's sign-in client.

### Embedding in Google Sites

Insert -> Embed -> By URL, pointing at `PUBLIC_SITE_URL`. The pages are responsive and
allow framing from `sites.google.com` (see `PUBLIC_FRAME_ANCESTORS`). Google sign-in will
not render inside the frame - the lookup form is the fallback, and users can open the page
in its own tab to sign in. A Google Sites page cannot reach the server on its own, so the
site still has to be published as above; Sites is only the wrapper.

---

## 3c. Nightly backup to the NAS

Enabled by pointing `BACKUP_DIR` at the share as mounted on this machine:

```
BACKUP_DIR=/Volumes/backups/repairs      # macOS SMB mount
BACKUP_HOUR=1                            # 1 AM local time
BACKUP_KEEP_DAYS=30
```

Every night at that time the app uses SQLite's **online backup API** (not `cp`, which can
tear a WAL database), gzips the result to `repairs-YYYY-MM-DD_HHMMSS.db.gz`, and deletes
backups older than the retention window. The scheduler recomputes the delay after each run,
so DST changes and sleeping machines are fine, and runs never overlap.

Two safety checks worth knowing about:

- If the folder does not exist and its **parent** does not either, the backup fails with
  "the share is not mounted" rather than creating the whole path locally.
- If the target is on the **same disk as the database**, it refuses - that is the signature
  of an unmounted NAS share. Override with `BACKUP_ALLOW_SAME_DISK=true` if you really do
  want a local copy.

Results are recorded in the `backups` table and shown in **Settings -> Nightly backup**,
where "Back up now" runs one on demand. `npm run backup` does the same from a terminal if
you would rather drive it from cron or launchd.

To restore: `gunzip repairs-....db.gz` and put the file where `DB_PATH` points, with the
app stopped.

---

## 3d. Loaners

A loaner is a Google device on the ticket, exactly like the machine being repaired: asset
tag, serial, model and device id, plus when it went out and when it came back.

- **What counts as a loaner:** anything in the org unit named by `LOANER_ORG_UNIT`
  (`/Devices/Loaners` by default), including sub-OUs. Nothing to tag by hand.
- **Finding one:** type or scan into the Loaner box on the ticket. `12`, `loaner-12` and
  `LOANER-012` all resolve to `Loaner-012` (`LOANER_TAG_PREFIX` + `LOANER_TAG_PAD`), and the
  search only looks inside the loaner OU, so a scan that matches exactly is linked
  immediately - one motion, no clicking through results.
- **Checkout and return:** linking stamps the checkout time; **Mark returned** stamps the
  return and clears the outstanding flag. The link stays on the ticket as history.
- **Nagging, gently:** while a loaner is out and the ticket is ready-for-pickup or closed,
  the drawer shows a warning, the pickup email asks the student to bring it back, and the
  public status page shows the same reminder.

`{{loaner_line}}` in a template is a whole sentence that changes with the status ("you have
loaner X in the meantime" / "please bring loaner X with you") and renders as nothing at all
when there is no loaner.

### Due dates, in school days

Issuing a loaner stamps a due date `LOANER_DUE_SCHOOL_DAYS` (default 5) school days out.
School days mean `LOANER_SCHOOL_WEEKDAYS` (Mon-Fri) minus `SCHOOL_HOLIDAYS`, so a loaner
handed out on Thursday is due the following **Thursday**, and a due date never lands on a
Saturday or in the middle of Christmas break. Put your breaks in `.env` once:

```
SCHOOL_HOLIDAYS=2026-11-25..2026-11-27,2026-12-21..2027-01-02,2027-03-15..2027-03-19
```

On the ticket you can set any date directly or press **+3 / +5 school days**. Both are
recorded on the ticket timeline, so "who extended this three times" is answerable.

### Return reminders

One pass a day at `LOANER_REMINDER_HOUR` (08:00 local):

| When | Who gets it |
| --- | --- |
| The day before it is due | the student |
| The day it is due | the student |
| Every `LOANER_OVERDUE_EVERY_DAYS` (3) while overdue, up to `LOANER_MAX_OVERDUE_NUDGES` (3) times | the student |
| Every day there is anything overdue, due today, or out after the repair finished | `LOANER_DIGEST_TO` (you) |

Reminders are **transactional**: they are about school property somebody still has, so they
ignore a ticket's status subscription list. They stop when the loaner is marked returned,
when the address has unsubscribed from everything, or when you switch that template's
auto-send off in Settings. Every send is recorded in `loaner_reminders`, so running the
pass twice in a day - or restarting mid-pass - cannot double-email a student. Re-issuing a
loaner on the same ticket starts the reminder history fresh.

**Loaners** in the nav is the deployed view: everything out, soonest due first, with days
out, days since the repair was finished (the number that catches loaners nobody chased),
which reminders have gone, and one-click **Returned** / **+5 days** / **Ticket**. Filters
cover overdue, due today or tomorrow, repair-done-but-still-out, and no-due-date. You can
also run the reminder pass or send yourself the digest from that page - useful the first
time, to see exactly what students would receive.

---

## 3e. Barcode scanning

Every asset-tag field takes barcodes two ways, with nothing to install:

- **Handheld scanners** (USB or Bluetooth) are keyboards: they type the code and press
  Enter. Fields clean up what arrives (stray control characters, doubled spaces) and treat
  Enter as "search now", so a scan into the loaner box links the loaner in one motion.
- **The camera**, through the browser's built-in `BarcodeDetector` - no library, no upload,
  frames never leave the machine. A small square button appears beside the field on
  browsers that support it (Chrome and ChromeOS do; Firefox does not), and simply is not
  shown where it would not work. Codabar, Code 39/128, EAN, UPC, QR and Data Matrix.

---

## 3f. The repair note written back to Google

When a ticket closes, the repair goes onto the device itself, so the next person to open
that Chromebook in the Admin console sees its history without needing this app:

```
Keyboard replaced 2025-09-02
2026-08-31 Ticket #142: Cracked screen - replaced LCD assembly and tested (jacob)
```

- The close form suggests a summary (from the category and your last note); edit it before
  saving and the preview updates live.
- Existing notes are **kept**. Google's notes field is finite, so when it fills up the
  oldest lines drop out first (`DEVICE_NOTES_MAX_CHARS`, default 500).
- Newlines are flattened, so one repair is always one line.
- A Google failure never blocks the close: the ticket closes, the failure is written to the
  ticket timeline, and **Write repair note to Google** (`POST /api/tickets/:id/repair-note`)
  retries it.
- Turn the whole thing off with `WRITE_REPAIR_NOTE_ON_CLOSE=false`; the manual button stays.

---

## 3g. Phones, and installing it as an app

The tech UI is responsive rather than a separate mobile app, because the useful thing at a
cart is the same screens with bigger targets:

- Tables become one card per row below 760px, so nothing scrolls sideways.
- Buttons and inputs are at least 44px tall; the tab bar and filter chips scroll
  horizontally instead of wrapping into a wall.
- The ticket drawer goes full-screen, and respects the notch (`env(safe-area-inset-*)`).
- Camera barcode scanning uses the rear camera, which is the whole point on a phone.

It also ships a web app manifest and a service worker, so on Android/ChromeOS Chrome offers
**Install app** (and iOS Safari's *Add to Home Screen* works): it then opens without browser
chrome, with the maroon status bar and the icons in `public/icons/`. Swap those PNGs for the
real Eagles logo whenever you like - same filenames, no code change.

The service worker caches only the shell (`index.html`, `app.js`, `styles.css`, icons).
API calls are never cached, so a tech is never shown stale ticket data; offline, the app
loads and tells you the request failed rather than lying. Installing requires https (or
localhost), which is another reason to finish the certificate.

---

## 3h. Inventory: parts, donors and parts on order

**Inventory** in the nav has four views: *On hand*, *Donor devices*, *Low stock* and
*Incoming parts*.

### On hand

One list holds both kinds of thing, told apart by `kind`:

- **Parts** - name, part number, category, which models they fit, bin, count, and a
  reorder point. A part at or below its reorder point is flagged low, and *Low stock* shows
  just those, which is your shopping list.
- **Donor devices** - a whole machine kept for spares, with its serial and asset tag.
  **Harvest** records what you took ("LCD panel"), optionally adds it to a part's count, and
  marks the donor *harvested* (or *exhausted* when there is nothing useful left).

Every count change writes a movement: what, how many, why, which ticket, who, when.
**History** on any row shows that trail, so "where did the last two batteries go" always has
an answer. The count on the item is just the running total of those movements - even the
opening count you type when adding a part is recorded as a receipt.

Two rules worth knowing:

- A part cannot go below zero. Fitting more than you have is refused with what is actually
  on the shelf, rather than quietly going negative.
- Removing a part that has any history **archives** it instead of deleting, so old repairs
  keep their references.

### On a ticket

The ticket drawer has a **Parts** card: search stock (or scan a bin label), set a quantity,
**Use it** - the count drops, the ticket timeline records `used 2 x Keyboard 300e from Bin
B1`, and **Put back** reverses it if you grabbed the wrong one. Underneath, *On the way*
lists any shipment carrying something for this ticket, with the sentence the student has
been told and a tracking link for you.

### Incoming parts

A shipment is one package: vendor, tracking number (the **carrier is detected** from the
number - UPS, FedEx, USPS, Amazon, DHL), expected day, and lines. Each line is a quantity
of either an inventory part or free text, and can name the ticket waiting for it - so one
order can serve several repairs.

- **Mark shipped** asks for the expected day and offers to email the students waiting on it,
  pre-ticked.
- **Receive** puts what actually turned up on the shelf (edit a number if the box came
  short), marks the shipment arrived, and tells the students their parts are here.
- Late shipments show in red on the page and in the daily digest email.

### Automatic tracking

Set `TRACKING_API_KEY` (AfterShip's free tier covers UPS, FedEx, USPS, Amazon and
DHL through one key) and shipment status follows the carrier by itself:

| Carrier says | Shipment becomes |
| --- | --- |
| label created / info received | `ordered` |
| in transit | `shipped` |
| out for delivery | `shipped`, with an out-for-delivery stamp |
| delivered | `delivered` |
| failed attempt / exception | `delayed` |

Three rules make it safe to leave running:

1. **It never sets `arrived`.** Delivered is the carrier's word; arrived means a
   human checked the parts into stock. The gap between those is real, so students
   are told "delivered to the school and waiting to be checked in" rather than
   something that sounds like the repair is finished.
2. **It never emails.** Not one message from a carrier movement - nobody wants
   "your Chromebook part reached Memphis" at 2am. The only parts emails are the
   ones you trigger (shipped, received) and the 8am "expected today" note.
3. **It never walks a status backwards** and never touches `arrived` or
   `cancelled`, so a stray late scan cannot un-deliver a package.

The poller runs every `TRACKING_POLL_MINUTES` (default 180) between
`TRACKING_HOUR_FROM` and `TRACKING_HOUR_TO` (6am-9pm), skips anything already
received, and caps each pass at `TRACKING_MAX_PER_RUN` so a free plan's quota
lasts. Carrier scans (with locations) are stored and shown on the shipment for
you, and the carrier's ETA updates the expected day. Settings -> Parcel tracking
shows the schedule, the last check, any failures, and a **Check all tracking
now** button; `npm run track` does the same from a shell.

Swapping providers means one file in `src/tracking/providers/`. A `mock` provider
drives the tests, so the logic is verified without touching a real API - but the
AfterShip request/response shape itself is only checked against their docs, so
watch the first live shipment.

### What students are told

Deliberately plain, and never the logistics:

> The parts for your repair have shipped and are expected Tuesday, Sep 8.

When tracking is on, that sentence keeps itself current: "expected Tuesday"
becomes "out for delivery today", then "delivered to the school and waiting to be
checked in", then "arrived and on the bench" once you receive it. Their status
page also grows a **Parts for this repair** list - ordered, shipped, out for
delivery, delivered, checked in, with dates - and those milestones are woven into
the main repair progress list in order. No carrier, no city, no tracking number:
a repair is not a parcel hobby.

That sentence appears in the *parts shipped* email, on their status page, and inside the
regular "waiting on a part" status email - `{{parts_expected_line}}` fills itself in from
any open shipment for that ticket, so you do not have to write it. Carrier, tracking number
and vendor stay on the tech side. Three templates cover it, all editable in Settings:
`parts_shipped`, `parts_arriving_today` (sent by the daily pass on the expected day) and
`parts_arrived`. Each student is told once per shipment per kind, so re-saving a shipment
cannot spam anybody.

---

## 4. Configuration (`.env`)

| Key | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | the tech app |
| `PUBLIC_URL` | `http://localhost:8080` | how staff reach the tech app |
| `OAUTH_REDIRECT_URI` | `PUBLIC_URL` + `/oauth2/callback` | set separately when the redirect must differ (see 2c) |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | empty | both set = Node serves https itself |
| `DB_PATH` | `./data/repairs.db` | the whole database is this one file |
| `APP_PASSWORD` | empty | empty = no login screen. **Set it before exposing the port** |
| `SESSION_SECRET` | auto | blank is fine: a random one is generated and stored in the database |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | from section 2 |
| `PUBLIC_SITE_ENABLED` | `true` | set `false` to run without the user-facing site |
| `PUBLIC_SITE_PORT` / `PUBLIC_SITE_HOST` | `8081` / `0.0.0.0` | the only port meant to be exposed |
| `PUBLIC_SITE_URL` | empty | the address users see; **required** for status/unsubscribe links in emails |
| `PUBLIC_GOOGLE_CLIENT_ID` | falls back to `GOOGLE_CLIENT_ID` | Google sign-in on the public page |
| `PUBLIC_ALLOWED_DOMAINS` | empty | comma separated; **empty disables sign-in entirely** |
| `PUBLIC_ALLOW_LOOKUP` | `true` | the asset tag + email form |
| `PUBLIC_TRUST_PROXY` | `false` | only true behind a proxy you control |
| `PUBLIC_FRAME_ANCESTORS` | Google Sites | CSP list of allowed embedders |
| `PUBLIC_TLS_*` | falls back to `TLS_*` | cert for the public hostname |
| `PUBLIC_LINK_SECRET` | auto | signs magic links; changing it invalidates every link already sent |
| `ORG_NAME`, `HELPDESK_NAME`, `HELPDESK_SIGNATURE` | | used in emails, the From: name, and the public page |
| `DEVICE_CACHE_TTL_MINUTES` | `720` | how long a cached device record is trusted |
| `DRY_RUN_EMAIL` | `false` | `true` renders and logs email without sending |
| `ALLOW_DEVICE_WRITEBACK` | `true` | `false` makes Google device data read-only |
| `BRAND_PRIMARY` / `BRAND_ACCENT` | `#8A1538` / `#ECAE12` | school maroon and gold; also `BRAND_INK`, `BRAND_MUTED`, `BRAND_WASH`, `BRAND_BORDER` |
| `LOANER_ORG_UNIT` | `/Devices/Loaners` | the Google OU that defines the loaner pool |
| `LOANER_TAG_PREFIX` / `LOANER_TAG_PAD` | `Loaner-` / `3` | how `12` expands to `Loaner-012` |
| `LOANER_DUE_SCHOOL_DAYS` | `5` | how long a loaner is out for by default |
| `LOANER_SCHOOL_WEEKDAYS` | `1,2,3,4,5` | which weekdays count (1 = Monday) |
| `SCHOOL_HOLIDAYS` | empty | `2026-12-21..2027-01-02,2026-11-26` - skipped by due dates |
| `LOANER_REMINDERS_ENABLED` | `true` | the daily reminder pass |
| `LOANER_REMINDER_HOUR` / `_MINUTE` | `8` / `0` | when it runs, local time |
| `LOANER_OVERDUE_EVERY_DAYS` | `3` | cadence of overdue nudges |
| `LOANER_MAX_OVERDUE_NUDGES` | `3` | then it stops nagging |
| `LOANER_DIGEST_ENABLED` / `LOANER_DIGEST_TO` | `true` / connected account | daily overdue list for the helpdesk |
| `WRITE_REPAIR_NOTE_ON_CLOSE` | `true` | append the repair to the device's Admin notes on close |
| `DEVICE_NOTES_MAX_CHARS` | `500` | when the notes field fills, oldest lines drop |
| `BACKUP_ENABLED` | `true` | needs `BACKUP_DIR` to do anything |
| `BACKUP_DIR` | empty | the NAS share as mounted here |
| `BACKUP_HOUR` / `BACKUP_MINUTE` | `1` / `0` | local time; non-numeric values are rejected with a warning |
| `BACKUP_KEEP_DAYS` | `30` | `0` keeps everything |
| `BACKUP_GZIP` | `true` | |
| `BACKUP_ALLOW_SAME_DISK` | `false` | see 3c |

Device records are cached in SQLite, so the queue and ticket pages never wait on Google.
"Refresh from Google" on a ticket, or `?refresh=1`, forces a fresh read.

### Asset tags that share a prefix

Google's `asset_id:` and `id:` queries match by **prefix**, so searching `24-1` also returns
`24-111` and `24-1000`. Results are therefore classified and ranked: an exact asset tag or
serial comes first and is labelled, and the prefix matches are collapsed behind
"N other devices whose tag or serial starts with the same text". Paste `24-21` and you land
on `24-21`, with `24-214` one click away instead of in your way.

---

## 5. Deploying to a server

**There is a runbook for this: [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).** It walks
through a Proxmox LXC with Docker, plain HTTP on the LAN, the BIND record in
Webmin, the NAS mount for backups, the Google OAuth entries, and the Chrome policy
that restores camera scanning on an http origin. `deploy/` also holds
`proxmox-lxc-create.sh`, `nas-mount.sh`, `docker-compose.prod.yml` and
`env.production.example`.

What follows is the generic version.

```bash
# with Docker
cp .env.example .env      # set PUBLIC_URL, APP_PASSWORD, SESSION_SECRET, Google creds
docker compose up -d --build
```

The database lives in `./data`, mounted into the container, so back that folder up (or
just copy `repairs.db` — SQLite is a single file; `sqlite3 repairs.db ".backup out.db"`
is the safe way to copy it while running).

Notes for a real deployment:

0. Forward only `PUBLIC_SITE_PORT` from outside; keep `PORT` on the LAN. If you run in
   Docker, mount the NAS share into the container at the same path as `BACKUP_DIR`.
1. Add the server's `https://.../oauth2/callback` to the OAuth client's redirect URIs
   (or use the SSH-tunnel option in section 2c).
2. Set `APP_PASSWORD` and a real `SESSION_SECRET`.
3. Terminate TLS in front of it (nginx, Caddy, Cloudflare Tunnel). The session cookie is
   automatically marked `secure` when `PUBLIC_URL` starts with `https://`.
4. Reconnect Google once from the deployed URL (the refresh token is per-database).

Without Docker: `npm install --omit=dev && node src/server.js` behind a systemd unit or
`pm2`. Node 20+ required.

---

## 6. Layout

```
src/
  server.js        both listeners (tech app + public site), TLS, OAuth callback
  config.js        .env -> config object, with validation
  db.js            schema, migrations, default email templates, settings helpers
  google.js        OAuth, ChromeOS search/get/update + match ranking, user lookup, Gmail send
  mailer.js        template render, send-or-skip, link footer, email log
  tickets.js       ticket CRUD, status transitions, events, stats
  subscriptions.js who gets emailed: per-ticket lists + account-wide opt-out
  backup.js        nightly SQLite online backup, retention, scheduler
  loaners.js       due dates, the deployed-loaners view, the daily reminder pass
  inventory.js     parts and donor devices, stock movements, harvesting
  shipments.js     parts on order, carrier detection, receiving, student notices
  tracking/        carrier polling: index.js (poller), statuses.js, providers/
  public-site.js   the entire user-facing site (server-rendered, own port)
  routes/api.js    the JSON API for the tech UI
  lib/statuses.js  the status + priority lists (edit here to change the workflow)
  lib/email-templates.js  the shipped maroon-and-gold emails
  lib/schooldays.js  school-day arithmetic (weekends, holidays)
  lib/links.js     signed magic-link tokens
  lib/session.js   optional shared-password gate
public/            index.html + app.js + styles.css (the tech UI)
                   manifest.webmanifest + sw.js + icons/ (installable app)
scripts/           seed-demo.js, backup.js
test/              node:test suites (159 tests)
data/              repairs.db (created on first run)
```

### JSON API (tech app)

```
GET    /api/meta | /api/stats
GET    /api/tickets?status=open|all|new,…&q=&assignee=&limit=&offset=
POST   /api/tickets                       {…fields, notify, notify_statuses?}
GET    /api/tickets/:id                   ticket + events + emails + subscriptions + history
PATCH  /api/tickets/:id                   {status?, note?, notify?, notify_statuses?, …fields}
DELETE /api/tickets/:id
POST   /api/tickets/:id/notes             {body, notify}
POST   /api/tickets/:id/email/preview     {status?, note?, subject?, body?}
POST   /api/tickets/:id/email/send        {status?, note?, subject?, body?}
GET    /api/tickets/:id/links             the user's status + preferences URLs
GET    /api/loaners/search?q=             the loaner OU only, by asset tag or serial
GET    /api/loaners/pool                  everything in the loaner OU
POST   /api/tickets/:id/loaner            {device_id} or {asset_tag} - links and stamps checkout
POST   /api/tickets/:id/loaner/return     stamps the return
DELETE /api/tickets/:id/loaner            unlink (mistake fix)
GET    /api/inventory?kind=&q=&low=1     items + stats + recent movements
POST   /api/inventory                    add a part or donor device
GET    /api/inventory/:id                item + its full movement history
PATCH  /api/inventory/:id | DELETE       edit; delete archives when there is history
POST   /api/inventory/:id/adjust         {delta, reason, note, ticket_id}
POST   /api/inventory/:id/harvest        {part_item_id?, qty, what, ticket_id?, exhausted?}
GET    /api/tickets/:id/parts            fitted parts + what is on the way
POST   /api/tickets/:id/parts            {item_id, qty, direction: 'use'|'return'}
GET    /api/shipments?status=open|all|…  shipments + stats
POST   /api/shipments                    {vendor, tracking_number, expected_day, lines:[…]}
PATCH  /api/shipments/:id | DELETE
POST   /api/shipments/:id/lines | DELETE /api/shipments/:id/lines/:lineId
POST   /api/shipments/:id/shipped        {expected_day, notify}
POST   /api/shipments/:id/receive        {lines:[{id, received_qty}], notify}
POST   /api/shipments/:id/notify         {kind} - re-send on purpose
POST   /api/shipments/:id/track          check this parcel with the carrier now
GET    /api/tracking | POST /api/tracking/poll   schedule status; force a pass
GET    /api/loaners/out?include_returned=1  the deployed-loaners page data + stats
PATCH  /api/tickets/:id/loaner/due       {due_day} or {extend_school_days}
POST   /api/loaners/reminders/run        run today's reminder pass now
POST   /api/loaners/digest/send          email yourself the overdue digest
GET    /api/tickets/:id/repair-note       the suggested summary + the line it would append
POST   /api/tickets/:id/repair-note       {summary} - write it to Google now
POST   /api/templates/reset               restore the shipped templates
GET    /api/devices/search?q=              serial / asset tag / user email, ranked
GET    /api/devices/recent | /api/devices/:deviceId?refresh=1
PATCH  /api/devices/:deviceId             {asset_tag?, annotated_user?, annotated_location?, notes?}
GET    /api/users/lookup?email=
GET    /api/templates | PUT /api/templates/:statusKey
GET    /api/optouts | POST /api/optouts   {email, action: 'in'|'out'}
GET    /api/backups | POST /api/backups/run
GET    /api/emails | GET /api/emails/:id
```

### Public site routes

```
GET  /                     sign-in / lookup landing (embeddable)
POST /lookup               asset tag + email (rate limited)
POST /signin               Google Identity Services callback
GET  /t/<id>.<mac>         this ticket's status
GET  /u/confirm/<t-token>  confirm the address before showing preferences
GET  /u/<id>.<mac>         email preferences
POST /u/<id>.<mac>         save preferences / unsubscribe
POST /u/<id>.<mac>/one-click   RFC 8058 one-click unsubscribe
```

### Changing the workflow

- **Statuses:** edit `src/lib/statuses.js`, then add a matching template in Settings
  (a new status with no template simply never emails). The public page's plain-language
  explanations live in `EXPLAIN` in `src/public-site.js`.
- **Issue categories:** the `categories` array in `src/routes/api.js` (`/api/meta`).
- **Fields on a ticket:** add the column in `db.js`, add it to `EDITABLE` in `tickets.js`,
  add an input in the drawer markup in `public/app.js`. That's the whole change; there is
  no ORM or schema generator to fight.

---

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `redirect_uri_mismatch` | `PUBLIC_URL` + `/oauth2/callback` must be listed verbatim in the OAuth client |
| "Google did not return a refresh token" | revoke the app at <https://myaccount.google.com/permissions> and connect again |
| "Google token is no longer valid" / `invalid_grant` | password change or revoked access - reconnect in Settings |
| 403 from Google on device search | the signed-in account lacks Chrome device privileges, or the Admin SDK API is not enabled on the project |
| Device search finds nothing | serials are exact; asset tags match `asset_id:`; for a person use their full email |
| Email fails with `insufficient permission` | the Gmail API is not enabled, or the connected account has no Gmail mailbox |
| `invalid ELF header` / `NODE_MODULE_VERSION` after moving the folder between machines | `rm -rf node_modules && npm install` (better-sqlite3 is a native module). In Docker this is `.dockerignore` doing its job - make sure it excludes `node_modules` |
| Docker build dies on `node-gyp rebuild` / `find Python` | npm could not fetch a prebuilt better-sqlite3 and tried to compile in an image without a toolchain. The shipped Dockerfile is multi-stage and installs `python3 make g++` in the builder for exactly this - rebuild with the current Dockerfile |
| Everything is slow | check that `data/repairs.db` is on local disk, not a synced folder like Drive or iCloud |
| Backup says "same disk as the database" | the NAS share is not mounted (that is the point of the check) - mount it, or set `BACKUP_ALLOW_SAME_DISK=true` for a deliberate local copy |
| Emails have no status/unsubscribe link | `PUBLIC_SITE_URL` is not set |
| A magic link says "not valid any more" | `PUBLIC_LINK_SECRET` changed, or the ticket was deleted |
| Google sign-in on the public page is refused | `PUBLIC_ALLOWED_DOMAINS` is empty (it fails closed) or the public origin is missing from the OAuth client's JavaScript origins |
| The sign-in button is missing inside Google Sites | Google's script refuses to run in an iframe; users can use the lookup form or open the page in a tab |
| A student says they get no emails | check Settings -> Unsubscribed addresses, then the ticket's own notification list |
| "Only 1 of X on hand" when fitting a part | the count is the count; correct it with +1/-1 on the Inventory page (that records an adjustment) rather than forcing it through |
| A part vanished from the list | removing an item with history archives it - it is still in the database and on old tickets |
| Students were not told about a shipment | they are told once per shipment per kind: check "Students told" on the shipment card, and use the shipment's notify endpoint to send again on purpose |
| The carrier is wrong or missing | it is guessed from the tracking number; set it explicitly by editing the shipment |
| Tracking never updates | Settings -> Parcel tracking: no key means it is off. Otherwise read the error on the shipment card - a bad key shows as 401, an exhausted free plan as 429 |
| A shipment says delivered but the parts are not on the shelf | that is exactly what the two states are for: click **Receive** when you physically check them in |
| Camera scanning or "Install app" stopped working in production | plain http is an insecure origin - add it to Chrome's `OverrideSecurityRestrictionsOnInsecureOrigin` policy in Google Admin, or move to https (deploy/RUNBOOK.md step 9) |
| A loaner tag is not found | the device must be in `LOANER_ORG_UNIT` in Google Admin; "Show pool" lists what is there |
| Scanning types the tag but nothing happens | the scanner is not sending Enter - set it to append a carriage return, or press Enter yourself |
| No camera button on the asset-tag fields | that browser has no `BarcodeDetector` (Firefox, older Safari). Chrome and ChromeOS do; handheld scanners work everywhere |
| The repair note did not reach Google | the ticket needs a linked Google device and the write scope; the ticket timeline has the error, and the drawer button retries |
| Emails still look like the old plain ones | Settings -> Reset to the school templates (seeding never overwrites existing rows) |
| No return reminders arrive | check the Loaners page: reminders need a due date, an outstanding loaner, a student email, and that template's auto-send on. "Run the reminder pass now" shows exactly what it skipped and why |
| Reminders landed during a break | put the break in `SCHOOL_HOLIDAYS` and re-issue or re-date the loan |
| A student got two reminders the same day | shouldn't be possible (every send is recorded in `loaner_reminders`); if it happens, check for two server processes on the same database |
| No "Install app" option | needs https (or localhost) and a reachable `manifest.webmanifest` - Chrome's Application tab lists what is missing |
