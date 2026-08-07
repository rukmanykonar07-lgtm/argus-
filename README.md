# ARGUS Pulse — Agency Ad Command Center

One dashboard for every client's ad performance across platforms —
spend, revenue, ROAS, campaign-level detail, and a rule-based insights
panel that explains *why* performance moved, not just that it did.

## Your data stays on your own machine — not ours

No central SmartDrop-owned server. Every copy of ARGUS Pulse is fully
self-contained: `npm start` saves everything to one file
(`argus_pulse_data.json`) next to the code, on whatever computer you
run it on. When you hand this to a client, deploy their copy on
**their own server or computer** — their ad data never touches
anything you control.

## Run it

```bash
npm install
npm start
```

Open `http://localhost:3001`. Works immediately in demo mode — add a
client, add an ad account with no real ID, hit sync.

## What's actually real right now (checked against the code, not assumed)

**✅ Meta (Facebook/Instagram) — fully live.** Add a real
`external_account_id` (the `act_XXXXXXXXX` from Meta Ads Manager) and
an access token, and it pulls real campaign data via the Insights API.

**✅ Google Ads — live, with one honest caveat.** Add a real customer
ID, an OAuth access token, and a Developer Token (Manager/MCC Customer
ID optional but usually required), and it pulls real data via GAQL.
**The caveat:** Google access tokens expire in about an hour. Meta's
System User tokens don't expire on a timer, so paste-once works there.
Google doesn't — you'll need to paste a fresh access token before each
sync until a proper OAuth refresh-token flow is built (`lib/google.js`
has the fetch logic; the refresh flow is the missing piece).

**❌ TikTok Ads — not connected, on purpose, and it says so.** No fetch
function exists for TikTok yet. Even if you paste a token into a
TikTok account, it will always show demo data — the code doesn't
pretend otherwise, and the UI shows a hint saying exactly this.

**The "Live" badge only shows true after an actual successful live
sync** — not just because a token field has something typed into it.
If real credentials fail (wrong token, expired, wrong permissions), it
honestly falls back to demo data and labels itself "demo," not "live."

## How it works

- **Clients** = your CRM layer — notes, status, one or more ad
  accounts underneath.
- **Sync** pulls the last ~200 days of campaign-level metrics (spend,
  impressions, clicks, conversions, revenue) and stores them locally,
  chunked by week per API call to avoid the timeout issues wide
  date-range pulls hit on both Meta and Google's APIs.
- **Insights engine** (`lib/store.js` → `generateInsights`) compares
  each campaign's current period against its previous period and
  flags real patterns — creative fatigue (CTR down + CPA up), reach
  going empty, clicks not converting, or genuine improvement — always
  labeled with honest confidence ("likely," "possibly," "unclear").
  Rule-based, not a black box, and not guessing when it doesn't know.

## Going live with real data

### Meta — do this first, it's the fastest and most durable path
1. Client adds your agency as a **Partner** in their Business Manager
   (standard practice — avoids Meta's App Review entirely for
   read-only reporting on accounts inside your own Business Manager).
2. Create a **System User** in your Business Manager (Business
   Settings → Users → System Users) — not a personal login. These
   don't expire on a timer, unlike personal OAuth tokens.
3. Generate a token for that System User with `ads_read`, assign it
   access to each client's ad account.
4. Paste that token in when adding the ad account.

### Google Ads
1. Create a Google Ads Manager (MCC) account if you don't have one.
2. Apply for a Developer Token in the MCC's API Center → Basic Access
   (free, reviewed in a few days to ~2 weeks).
3. Generate an OAuth access token (e.g. via Google's OAuth Playground,
   or your own OAuth app) — remember it expires hourly.
4. Add the account with: the client's Customer ID, your Developer
   Token, your Manager (MCC) Customer ID, and the access token.

## What's built vs. what's genuinely still missing

**Built:**
- Client/CRM layer, multi-account-per-client, portfolio landing grid
- Real Meta + Google Ads integration (Google's caveat noted above)
- Revenue/ROAS tracking, sparklines, platform donut chart
- Date range (7/14/30/90d) with period-over-period % change
- Search + status + platform filtering on the campaign table
- Rule-based insights engine explaining performance shifts
- Historical daily storage so trend charts and comparisons work

**Not built yet — the real remaining gaps:**
- **TikTok Ads integration** — no fetch function exists at all
- **Google OAuth refresh-token flow** — currently needs a manually
  re-pasted access token every ~hour for live syncs to keep working
- **Scheduled auto-sync** — still a manual "Sync All" button;
  `node-cron` is installed but not wired up
- **White-label client portal** — only you see the dashboard right
  now; no separate branded client login
- **PDF/scheduled email reports** — the "lands in your inbox every
  Monday" pitch competitors lead with isn't built
- **SEO/rank tracking or non-ads channels** — this tool is ads-only;
  AgencyAnalytics/Oviond cover 50-85+ integrations beyond ad platforms
- **Token encryption at rest** — currently stored as plain text in the
  JSON file. Fine for single-agency internal use, **must fix before
  selling this to other agencies** who'll store their own clients'
  tokens in it
- **Multi-tenant signup flow** — the `tenant_id` field exists in the
  schema for this, but everything currently defaults to `'default'`

## Stack

Node.js + Express + a plain JSON file for storage — no database
software, no native modules, nothing needing a C++ compiler (an
earlier version used better-sqlite3, which needs Visual Studio Build
Tools on Windows — a dealbreaker for handing this to a client with
just Node installed, so it was swapped out). Chart.js via CDN, no
build step.
