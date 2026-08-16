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

**No login/auth layer.** This is intentional for a single-agency tool
running on your own laptop — anyone who can reach `localhost:3001`
already has physical/network access to that machine. If you ever run
a copy somewhere reachable by more than just you (a shared office
network, a cloud VM, etc.), put it behind a reverse proxy with auth
in front — the app itself doesn't gate any route.

**Ad account tokens are encrypted at rest and never sent back to the
browser.** A local key file (`argus_pulse.key`, gitignored, chmod 600)
is generated next to the data file on first run; tokens are encrypted
with it before touching disk, and the `/api/clients` response only
ever tells the frontend *whether* a token is set (`has_access_token`,
etc.), never the value. This protects against someone opening the
JSON file, grabbing a backup, or reading the API response in
devtools — not against someone with full access to the same machine
and the key file sitting next to it. There's no secure enclave on a
laptop; that's the realistic bar.

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

**✅ Google Ads — live, two ways to authenticate.** Add a real customer
ID and a Developer Token (Manager/MCC Customer ID optional but usually
required), then either:
- **Recommended — OAuth Client ID + Client Secret + Refresh Token.**
  Self-renewing: sync fetches a fresh ~hour-long access token from
  Google automatically every time, including for the scheduled
  auto-sync below. Set these up once in a Google Cloud OAuth app.
- **Manual — a pasted Access Token.** Works immediately with no OAuth
  app setup, but Google tokens expire in about an hour, so you'll need
  to paste a fresh one before each manual sync. Fine for testing;
  not for the scheduled auto-sync, since there's nothing to
  auto-renew it.

(Meta's System User tokens don't expire on a timer, so paste-once
works fine there — no refresh flow needed for Meta.)

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
- Reach, Frequency, CPM, CPC — pulled from Meta directly (Google's simple
  ad-level query doesn't include reach; Google's Reach & Frequency API is
  a separate, more complex integration not wired up)
- Meta's own Quality/Engagement/Conversion Rate rankings, surfaced at ad
  level — this is Meta's own diagnostic signal for why an ad underperforms
  vs competitors for the same audience, not our own inference
- **Platform tabs now actually filter everything** — previously clicking
  Meta/Google only filtered the breakdown table's row list; the KPI totals,
  trend chart, and donut chart stayed combined regardless of tab. Fixed at
  the root: `getClientSummary()` now accepts a `platform` filter and
  recomputes the whole tree/timeseries/totals from platform-scoped metrics,
  not just the campaign list.
- **KPI groups are now genuinely platform-specific**, not one generic set
  with "(Meta)" tags bolted on: Meta tab shows Reach/Frequency/Engagement
  as real numbers with clean labels; Google tab drops those entirely (they
  don't exist for Google) and shows a Search Visibility group instead when
  the data's available; the "All" tab keeps the combined view with tags
  since it's genuinely mixed data.
- Fixed a bug where changing the date range silently reset the platform
  tab back to "All" (selectClient was resetting it on every call, not
  just when switching clients).
- **Fixed a real data-correctness bug**: campaigns were keyed by name
  alone in the aggregation tree, so a Meta campaign and a Google campaign
  sharing a name (e.g. both called "Brand Search" — common, agencies do
  this deliberately for tracking) silently merged into one node and one
  platform's numbers disappeared. Now keyed by platform+name internally,
  display name stays clean. Verified with a real sync: was returning 5
  campaigns for two connected accounts, now correctly returns 10.
- The breakdown table's column headers are now actually clickable to sort
  (spend, impressions, clicks, CTR, conversions, CPA, ROAS, name) —
  previously `sortKey`/`sortDir` were being set by the KPI-card click
  shortcut but never applied anywhere, so clicking a KPI card did nothing
  visible. Also removed a redundant client-side platform filter in the
  table now that the summary itself is already platform-scoped.
- Engagement, Video Views, Link Clicks — pulled from Meta's existing
  `actions` array (already fetched for conversions), zero extra API cost
- Google Search Impression Share (+ the two loss reasons: rank/bid vs
  budget) — campaign-level snapshot for Search/Shopping/PMax campaigns,
  best-effort so a failure here can't break the main sync
- KPI cards grouped into Outcomes / Efficiency & Delivery / Engagement
  instead of one flat wall, so the eye lands on business results first
- Date range (7/14/30/90d) with period-over-period % change
- Search + status + platform filtering on the campaign table
- Rule-based insights engine explaining performance shifts, at every level
  (brand, campaign, ad set, ad)
- Historical daily storage so trend charts and comparisons work

**Honest caveat on Reach:** when pulled per-day (which this does, to keep
trend charts and range filtering working), summing daily reach across a
date range slightly overcounts people who saw the ad on more than one day
— it's not a perfectly deduplicated unique-reach number for the whole
period, just a reasonable approximation. Frequency (impressions ÷ reach)
inherits that same approximation.

**Honest caveat on Engagement:** Meta's `post_engagement` action is their
own rollup (likes + comments + shares + link clicks + a few more) — we're
not recomputing it, just surfacing what Meta already reports.

**Honest caveat on Search Impression Share:** it's a live snapshot (last
7 days, at sync time), not stored daily history like the other metrics —
so it won't show trend deltas or feed the sparklines the way Reach/CTR do.

**Still not tracked — the real remaining gaps:**
- Video watch-time metrics (ThruPlays, average watch time, video view rate
  — we only have raw video_view count, not depth of watch)
- Placement breakdown (feed vs. Stories vs. Reels vs. Audience Network)
- Demographic/geographic breakdown (age, gender, region)
- Google's reach/frequency (needs the separate Reach Planning API)
- Google's Quality Score (separate from Search Impression Share, needs a
  keyword-level query — not wired up yet)

**Fixed since the first pass:**
- **Google OAuth refresh-token flow** — build it once with a Client
  ID + Client Secret + Refresh Token, sync self-renews from there
  (`lib/google.js` → `getAccessTokenFromRefreshToken`). Manual
  access-token paste still works too, as a fallback.
- **Scheduled auto-sync** — `node-cron` now actually runs
  `syncAllAccounts()` daily at 6am (`server.js`, bottom). "Sync All"
  in the UI still works for on-demand syncs.
- **Token encryption at rest** — access/developer/refresh tokens and
  the OAuth client secret are AES-256-GCM encrypted before hitting
  `argus_pulse_data.json`, using a locally generated key file
  (`argus_pulse.key`, gitignored, chmod 600). See `lib/crypto.js`.
- **Token leak via the API** — `GET /api/clients` used to return raw
  tokens to the browser (visible in devtools). It now only returns
  `has_access_token` / `has_developer_token` / `has_refresh_token`
  booleans; the actual values never leave the server.

**Not built yet — the real remaining gaps:**
- **TikTok Ads integration** — no fetch function exists at all
- **White-label client portal** — only you see the dashboard right
  now; no separate branded client login
- **PDF/scheduled email reports** — the "lands in your inbox every
  Monday" pitch competitors lead with isn't built
- **SEO/rank tracking or non-ads channels** — this tool is ads-only;
  AgencyAnalytics/Oviond cover 50-85+ integrations beyond ad platforms
- **Multi-tenant signup flow** — the `tenant_id` field exists in the
  schema for this, but everything currently defaults to `'default'`.
  Fine as-is for the "one copy per client" model since each install
  is single-tenant by nature; only matters if this ever becomes one
  shared hosted instance serving multiple agencies.

## Stack

Node.js + Express + a plain JSON file for storage — no database
software, no native modules, nothing needing a C++ compiler (an
earlier version used better-sqlite3, which needs Visual Studio Build
Tools on Windows — a dealbreaker for handing this to a client with
just Node installed, so it was swapped out). Chart.js via CDN, no
build step.
