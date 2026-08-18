# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Primary user: a solo agency operator (or small agency team) managing paid-ad accounts for multiple clients across platforms. They run this tool themselves, on their own machine, to check spend/ROAS and catch problems across all client accounts without logging into each ad platform separately.

## Product Purpose
ARGUS Pulse is a single dashboard that aggregates every client's ad performance (Meta and Google Ads, live; other platforms scaffolded) into one view — spend, revenue, ROAS, campaign/ad-set/ad-level detail — plus a rule-based insights layer that flags *why* performance moved (not just that it did) and surfaces issues that need attention.

## Positioning
Self-hosted, single-tenant: no central SmartDrop-owned server, no login/auth layer by design (each install runs on the operator's own machine, one file of local storage, tokens encrypted at rest). A neighboring SaaS ad dashboard could not truthfully claim this — it's built for one agency to run privately, not as a multi-tenant hosted product.

## Operating Context
Run via `npm start`, opened at `localhost:3001`. Used by the operator during account review / client reporting sessions — scanning many clients' accounts for problems, drilling into a flagged campaign → ad set → ad to diagnose it, then acting (pausing, adjusting budget, or flagging to the client).

## Capabilities and Constraints
- Existing stack: vanilla HTML/CSS/JS frontend (`public/index.html`, single file) + Express backend (`server.js`, `lib/`). No framework, no build step. This is preserved — redesign works within it, not a framework migration.
- Live integrations: Meta Ads Insights API (full), Google Ads API (OAuth or manual token).
- Rule-based insights engine (`lib/insights.js`) explains performance changes; not ML-based.
- No auth layer by design; local JSON data file; encrypted token storage.

## Evidence on Hand
- Existing implementation at `public/index.html`, currently at "v9" per an internal build marker, already through several rounds of spacing/layout fixes (4px spacing scale, max-width container) and a consolidated single-page view (Overview/Attention/Breakdown merged from three tabs into one continuous page).
- User's stated complaint: current visual design is a "way too shitty" — not a functional complaint, a look-and-feel one. This is treated as evidence of the incumbent look, not as product truth to preserve.

## Product Principles
- Scanability over decoration — this is an Operate-mode tool used to catch problems fast across many accounts, not a marketing surface.
- Trust through precision — an ad-performance tool's credibility rides on clean, accurate data presentation; sloppy visual execution undermines trust in the numbers themselves.
- Local-first, single-operator — no multi-user chrome, no admin-console patterns borrowed from SaaS products this isn't.
