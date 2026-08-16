require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const store = require('./lib/store');
const { fetchMetaInsights } = require('./lib/meta');
const { fetchGoogleAdsInsights, fetchSearchVisibility, getAccessTokenFromRefreshToken } = require('./lib/google');
const { generateMockMetrics } = require('./lib/mock');
const { sendAlert } = require('./lib/alerts');
const { createSession, getSession, destroySession, parseCookies } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());

// ---------- Auth ----------
// Cookie-based sessions, not a JWT and not express-session — see
// lib/auth.js for why. Static files and the /api/auth/* routes are the
// only things reachable without a session; everything else under /api
// goes through requireAuth below.
const SESSION_COOKIE = 'argus_session';

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = token && getSession(token);
  if (!session) return res.status(401).json({ error: 'not logged in' });
  const user = store.getUserById(session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

// Basic brute-force lockout — the login route had zero rate limiting.
// Fine on a truly local-only machine, not fine the moment this runs on a
// shared network (the README explicitly documents that as a real
// possibility). In-memory, keyed by username — matches the same
// "restarts rarely, in-memory is fine" reasoning as sessions in lib/auth.js.
const failedLogins = new Map(); // username -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
function isLockedOut(username) {
  const entry = failedLogins.get(username.toLowerCase());
  return !!(entry && entry.lockedUntil && Date.now() < entry.lockedUntil);
}
function recordFailedLogin(username) {
  const key = username.toLowerCase();
  const entry = failedLogins.get(key) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
  failedLogins.set(key, entry);
}
function clearFailedLogins(username) {
  failedLogins.delete(username.toLowerCase());
}

// First-run: no users exist yet, so anyone can create the first account —
// it's always granted admin (see store.addUser). After that, setup is
// closed; only an existing admin can add more users via /api/auth/users.
app.post('/api/auth/setup', (req, res) => {
  if (store.userCount() > 0) return res.status(400).json({ error: 'setup already completed — log in instead' });
  const { username, password } = req.body;
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'username and an 8+ character password required' });
  const id = store.addUser({ username, password, role: 'admin' });
  const token = createSession(id);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
  res.json({ ok: true, user: { id, username, role: 'admin' } });
});

app.get('/api/auth/setup-needed', (req, res) => {
  res.json({ needed: store.userCount() === 0 });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (isLockedOut(username || '')) return res.status(429).json({ error: 'Too many failed attempts — wait a few minutes and try again.' });
  const user = store.verifyUserPassword(username || '', password || '');
  if (!user) { recordFailedLogin(username || ''); return res.status(401).json({ error: 'wrong username or password' }); }
  clearFailedLogins(username || '');
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) destroySession(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

app.get('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  res.json(store.getUsers());
});

app.post('/api/auth/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'username and an 8+ character password required' });
  const id = store.addUser({ username, password, role });
  res.json({ id });
});

app.delete('/api/auth/users/:id', requireAuth, requireAdmin, (req, res) => {
  const ok = store.deleteUser(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'user not found' });
  res.json({ ok: true });
});

app.use('/api', requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Clients (CRM layer) ----------
app.get('/api/clients', (req, res) => {
  res.json(store.getClients());
});

app.post('/api/clients', (req, res) => {
  const { name, status, notes, target_cpa, target_roas, monthly_budget, webhook_url, management_fee_pct } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = store.addClient({ name, status, notes, target_cpa, target_roas, monthly_budget, webhook_url, management_fee_pct });
  res.json({ id });
});

app.patch('/api/clients/:id', (req, res) => {
  const { status, notes, target_cpa, target_roas, monthly_budget, webhook_url, management_fee_pct } = req.body;
  const ok = store.updateClient(req.params.id, { status, notes, target_cpa, target_roas, monthly_budget, webhook_url, management_fee_pct });
  if (!ok) return res.status(404).json({ error: 'client not found' });
  res.json({ ok: true });
});

// ---------- Ad accounts ----------
app.post('/api/clients/:clientId/ad-accounts', (req, res) => {
  const {
    platform, external_account_id, label,
    access_token, developer_token, manager_customer_id,
    // Google OAuth refresh flow (optional) — client_id/client_secret are the
    // agency's own Google Cloud OAuth app credentials, refresh_token is
    // long-lived. When these three are present, sync fetches a fresh
    // access_token automatically instead of needing one manually re-pasted
    // every ~hour.
    client_id, client_secret, refresh_token,
  } = req.body;
  if (!platform || !external_account_id) return res.status(400).json({ error: 'platform and external_account_id required' });
  if (!store.getClientById(req.params.clientId)) return res.status(404).json({ error: 'client not found' });
  const id = store.addAdAccount(req.params.clientId, {
    platform, external_account_id, label, access_token, developer_token, manager_customer_id,
    client_id, client_secret, refresh_token,
  });
  res.json({ id });
});

// ---------- Sync (pull metrics — real if credentials present, mock otherwise) ----------
// Pulled into its own function so both the manual "Sync" button (route
// below) and the scheduled auto-sync (cron, bottom of file) share one
// code path instead of drifting apart.
async function syncAccount(accountId) {
  const account = store.getAdAccount(accountId);
  if (!account) throw Object.assign(new Error('ad account not found'), { status: 404 });

  // A stored credential existing-but-undecryptable must never look like
  // "mock mode because nothing was configured" — that would mean real ad
  // data silently stops syncing with no visible sign anything's wrong.
  // Surface it as a distinct sync outcome instead.
  if (account.credentialsCorrupted) {
    store.markSynced(account.id, 'credentials_corrupted');
    throw Object.assign(new Error("This account's stored credentials couldn't be decrypted (the encryption key file may have changed). Re-enter its credentials to resume real syncing."), { status: 409 });
  }

  // Pull 200 days back so the 90-day range still has a full previous-90-day
  // window to compare against — otherwise "vs previous period" breaks at
  // the edges of whatever we've stored.
  const HISTORY_DAYS = 200;
  let rows, mode;
  try {
    if (account.platform === 'meta' && account.access_token) {
      const until = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
      rows = await fetchMetaInsights(account.external_account_id, account.access_token, since, until);
      mode = 'live';
    } else if (account.platform === 'google' && account.developer_token &&
               (account.access_token || (account.refresh_token && account.google_client_id && account.client_secret))) {
      // Prefer the refresh-token flow when it's on file — it self-renews,
      // so sync (including the scheduled one below) keeps working
      // unattended. Fall back to a manually pasted access_token otherwise
      // (works until it expires in ~an hour, same as before).
      let accessToken = account.access_token;
      if (account.refresh_token && account.google_client_id && account.client_secret) {
        accessToken = await getAccessTokenFromRefreshToken(account.google_client_id, account.client_secret, account.refresh_token);
      }
      const until = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
      rows = await fetchGoogleAdsInsights(account.external_account_id, accessToken, account.developer_token, account.manager_customer_id, since, until);
      mode = 'live';
      // Best-effort — Search Impression Share is a nice-to-have diagnostic,
      // not core sync data, so a failure here must never break the sync
      try {
        const visibility = await fetchSearchVisibility(account.external_account_id, accessToken, account.developer_token, account.manager_customer_id);
        store.setSearchVisibility(account.id, visibility);
      } catch (err) {
        console.error('Search visibility fetch failed (non-fatal):', err.message);
      }
    } else {
      // TikTok has no real integration built yet — always mock,
      // regardless of what's typed into the token field. Not silently
      // pretending otherwise.
      rows = generateMockMetrics(account.id, HISTORY_DAYS);
      mode = 'mock';
    }
  } catch (err) {
    console.error(`Sync failed for account ${account.id}, falling back to mock:`, err.message);
    rows = generateMockMetrics(account.id, HISTORY_DAYS);
    mode = 'mock';
  }

  store.clearMetrics(account.id);
  store.insertMetrics(account.id, rows);
  store.markSynced(account.id, mode);

  return { mode, rowsSynced: rows.length };
}

app.post('/api/ad-accounts/:id/sync', async (req, res) => {
  try {
    const result = await syncAccount(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- Metrics ----------
app.get('/api/ad-accounts/:id/metrics', (req, res) => {
  res.json(store.getMetrics(req.params.id));
});

function parseRangeQuery(req) {
  const { days, since, until, platform } = req.query;
  const range = since && until ? { since, until } : { days: Number(days) || 30 };
  return { ...range, platform };
}

// Combined summary for one client — KPIs, full Campaign -> Ad Set -> Ad
// tree (each node carrying its own insight), timeseries, platform breakdown
app.get('/api/clients/:id/summary', (req, res) => {
  if (!store.getClientById(req.params.id)) return res.status(404).json({ error: 'client not found' });
  res.json(store.getClientSummary(req.params.id, parseRangeQuery(req)));
});

// Portfolio rollup — every client with mini KPIs, for the landing grid
app.get('/api/portfolio', (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(store.getPortfolio('default', days));
});

// ---------- Rules & recommended actions ----------
// Recommend-only by design — see the comment on evaluateRulesForClient
// in lib/store.js for why this never touches a live ad account.
app.get('/api/clients/:clientId/rules', (req, res) => {
  res.json(store.getRulesByClient(req.params.clientId));
});

app.post('/api/clients/:clientId/rules', (req, res) => {
  const { name, metric, operator, value, action } = req.body;
  if (!metric || !operator || value === undefined) return res.status(400).json({ error: 'metric, operator, and value required' });
  if (!store.getClientById(req.params.clientId)) return res.status(404).json({ error: 'client not found' });
  const id = store.addRule(req.params.clientId, { name, metric, operator, value, action });
  res.json({ id });
});

app.delete('/api/rules/:id', (req, res) => {
  const ok = store.deleteRule(req.params.id);
  if (!ok) return res.status(404).json({ error: 'rule not found' });
  res.json({ ok: true });
});

app.post('/api/actions/:id/resolve', (req, res) => {
  const { status } = req.body; // 'dismissed' or 'done'
  if (!['dismissed', 'done'].includes(status)) return res.status(400).json({ error: "status must be 'dismissed' or 'done'" });
  const ok = store.resolveAction(req.params.id, status);
  if (!ok) return res.status(404).json({ error: 'action not found' });
  res.json({ ok: true });
});

// ---------- Scheduled auto-sync ----------
// Runs every day at 6am on whatever machine this is running on — no more
// depending on someone remembering to click "Sync All." node-cron was
// already a dependency; this is what actually wires it up. Errors per
// account are caught and logged so one bad account (e.g. an expired
// Google token with no refresh flow set up) can't block the rest.
async function syncAllAccounts() {
  const clients = store.getClients();
  for (const client of clients) {
    for (const account of client.ad_accounts) {
      try {
        const result = await syncAccount(account.id);
        console.log(`Auto-sync: account ${account.id} (${account.label}) -> ${result.mode}, ${result.rowsSynced} rows`);
      } catch (err) {
        console.error(`Auto-sync failed for account ${account.id} (${account.label}):`, err.message);
      }
    }
    // One check per client per day (cron runs once daily) — that cadence
    // is the rate limit, no separate dedupe/cooldown logic needed.
    if (client.webhook_url) {
      try {
        const summary = store.getClientSummary(client.id, { days: 30 });
        await sendAlert(client.webhook_url, client, summary);
      } catch (err) {
        console.error(`Alert failed for client ${client.id} (${client.name}):`, err.message);
      }
    }
  }
}
cron.schedule('0 6 * * *', syncAllAccounts);

// ---------- Error handling ----------
// Express's default error page is a raw HTML dump with the full server
// stack trace and file paths — fine for you debugging locally, not
// something a client should ever see if this throws on their machine.
// Must be registered last (Express matches error middleware by arity).
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.path} failed:`, err.message);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server — check the terminal log.' : err.message });
});

app.listen(PORT, () => console.log(`ARGUS Pulse running on http://localhost:${PORT}`));
