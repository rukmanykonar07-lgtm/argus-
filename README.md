# ARGUS Pulse — Agency Ad Command Center

Replaces AgencyAnalytics / Oviond / Swydo-type tools ($39–199+/mo) for
marketers and agencies managing multiple clients' ad accounts. One
dashboard: every client, every ad account, organized, with performance
trends stored over time (not just live snapshots).

## Your data stays on your own machine — not ours

There is no central SmartDrop-owned server involved. Every copy of
ARGUS Pulse is fully self-contained: when you run `npm start`, it saves
everything to one file (`argus_pulse_data.json`) sitting right next to
the code, on whatever computer or server you started it on.

That means: when you hand this to a client, deploy their copy on
**their own server or computer** — their ad account data then lives
entirely on their machine, never touching anything you control. This
is the whole point of the "you own it, one-time build" pitch — it's
not a subscription to a service you host, it's software they run.

## What the dashboard looks like

- **Portfolio landing page** — opens showing every client at once as a
  grid of cards (spend, clicks, CTR, live/demo status), click any card
  to drill in. This is the missing piece the earlier version had —
  a real overview, not just an empty "select a client" screen.
- **Live vs Demo badge** — every client and account is clearly tagged
  so fake demo numbers can never be mistaken for real ones.
- **Date range selector** — 7 / 14 / 30 / 90 days, top of the client
  view.
- **Change vs previous period** — a ▲/▼ percentage next to every KPI,
  comparing the selected range to the same-length period before it.
- **Sidebar** — every client, click to open (AgencyAnalytics/Databox
  pattern).
- **KPI row** — spend, impressions, clicks, CTR, CPA, merged across
  every ad account that client has connected.
- **Campaign performance table** — every campaign across every
  platform, sortable by any column, tagged with platform and an
  Active/Paused status.
- **Trend chart** — spend and clicks over the selected range.
- **Ad accounts strip** — every connected account, when it last
  synced, and live/demo status per account.

## Run it

```bash
npm install
npm start
```

Open `http://localhost:3001`.

Works immediately in **demo mode** — add a client, add an ad account with
no real ID, hit sync, and it generates realistic (deterministic, not
random-noise) mock performance data so you can demo it to a client or
film the reel before any real integration is wired up.

## How it works

- **Clients** = your CRM layer. Each has notes, status, and one or more
  ad accounts underneath.
- **Ad accounts** = a Meta/Google/TikTok account linked to a client. Add
  a real `external_account_id` + access token to pull live data; leave
  blank for demo data.
- **Sync** pulls the last 30 days of campaign-level metrics and stores
  them in a local file (`argus_pulse_data.json`, plain JSON — no
  database software or compiler needed to install, so it runs on a
  fresh Windows/Mac laptop with nothing but Node.js) — this is *why*
  the dashboard can show trend charts over time, which the raw ad
  platform APIs don't give you cleanly on their own.
- **Overview strip** at the top rolls up spend/clicks/CPA across every
  client and account you manage — the single-glance view that's the
  whole point of the tool.

## Going live with real data

### Meta (Facebook/Instagram) — do this first, it's the fastest path
1. Have each client add your agency as a **Partner** in their Business
   Manager (standard practice — this avoids Meta's App Review process
   entirely for read-only reporting, since review is only required when
   pulling data from accounts *outside* your own Business Manager).
2. Create a **System User** in your Business Manager (Business Settings
   → Users → System Users) — not a personal login. System User tokens
   don't expire on a 60-day timer like personal OAuth tokens do, which
   matters because this needs to keep syncing unattended for months.
3. Generate a token for that System User with `ads_read` permission,
   assign it access to each client's ad account.
4. Paste that token in when you add the ad account in the UI. The
   `external_account_id` is the `act_XXXXXXXXX` ID from Meta Ads Manager.

### Google Ads — v2, needs a few days' lead time
1. Create a Google Ads Manager (MCC) account if you don't have one.
2. Apply for a Developer Token in the MCC's API Center, then apply for
   **Basic Access** (free, reviewed in a few days to ~2 weeks — start
   this early, don't block the Meta rollout on it).
3. Once approved, one token covers every client account linked under
   your MCC. Google Ads integration code isn't wired up yet in this
   build — `lib/meta.js` is the pattern to copy for `lib/google.js`.

## What's built vs. what's next

**Built (v1):**
- Client/CRM layer with notes + status
- Multi-account-per-client support (the exact gap AgencyAnalytics's
  cheap tier deliberately locks out)
- Real Meta Insights API integration, chunked by week to avoid the
  timeout issue wide date-range pulls hit
- Demo/mock mode per account so it's always presentable
- Cross-client overview rollup
- Historical daily storage (SQLite) so trend charts work

**Not built yet (v2):**
- Google Ads + TikTok Ads integrations (Meta pattern is there to copy)
- Scheduled auto-sync (currently manual "Sync Now" — add `node-cron`,
  already installed, to run syncs every few hours)
- White-label client portal (separate login, your branding, client sees
  only their own data)
- PDF/scheduled email reports
- Token encryption at rest (currently stored plain in SQLite — fine for
  single-agency internal use, **must fix before selling this to other
  agencies** — encrypt with a key from env, not committed to the repo)
- Multi-tenant signup flow (the `tenant_id` column is already in the
  schema for this — right now everything defaults to `'default'`)

## Stack

Node.js + Express + a plain JSON file for storage — deliberately no
database software, no native modules, nothing that needs a C++
compiler (an earlier version used better-sqlite3, which requires
Visual Studio Build Tools on Windows — a real dealbreaker for handing
this to a client who just has Node installed, so it was swapped out).
Fine for this data volume; if you outgrow it later (many agencies,
years of daily data), that's the point to move to a real database.
Chart.js via CDN for the trend charts, no build step.
