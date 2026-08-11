require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./lib/store');
const { fetchMetaInsights } = require('./lib/meta');
const { fetchGoogleAdsInsights, fetchSearchVisibility } = require('./lib/google');
const { generateMockMetrics } = require('./lib/mock');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Clients (CRM layer) ----------
app.get('/api/clients', (req, res) => {
  res.json(store.getClients());
});

app.post('/api/clients', (req, res) => {
  const { name, status, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = store.addClient({ name, status, notes });
  res.json({ id });
});

app.patch('/api/clients/:id', (req, res) => {
  const { status, notes } = req.body;
  store.updateClient(req.params.id, { status, notes });
  res.json({ ok: true });
});

// ---------- Ad accounts ----------
app.post('/api/clients/:clientId/ad-accounts', (req, res) => {
  const { platform, external_account_id, label, access_token, developer_token, manager_customer_id } = req.body;
  if (!platform || !external_account_id) return res.status(400).json({ error: 'platform and external_account_id required' });
  const id = store.addAdAccount(req.params.clientId, { platform, external_account_id, label, access_token, developer_token, manager_customer_id });
  res.json({ id });
});

// ---------- Sync (pull metrics — real if token present, mock otherwise) ----------
app.post('/api/ad-accounts/:id/sync', async (req, res) => {
  const account = store.getAdAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'ad account not found' });

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
    } else if (account.platform === 'google' && account.access_token && account.developer_token) {
      const until = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
      rows = await fetchGoogleAdsInsights(account.external_account_id, account.access_token, account.developer_token, account.manager_customer_id, since, until);
      mode = 'live';
      // Best-effort — Search Impression Share is a nice-to-have diagnostic,
      // not core sync data, so a failure here must never break the sync
      try {
        const visibility = await fetchSearchVisibility(account.external_account_id, account.access_token, account.developer_token, account.manager_customer_id);
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
    console.error('Sync failed, falling back to mock:', err.message);
    rows = generateMockMetrics(account.id, HISTORY_DAYS);
    mode = 'mock';
  }

  store.clearMetrics(account.id);
  store.insertMetrics(account.id, rows);
  store.markSynced(account.id, mode);

  res.json({ ok: true, mode, rowsSynced: rows.length });
});

// ---------- Metrics ----------
app.get('/api/ad-accounts/:id/metrics', (req, res) => {
  res.json(store.getMetrics(req.params.id));
});

function parseRangeQuery(req) {
  const { days, since, until } = req.query;
  return since && until ? { since, until } : { days: Number(days) || 30 };
}

// Combined summary for one client — KPIs, full Campaign -> Ad Set -> Ad
// tree (each node carrying its own insight), timeseries, platform breakdown
app.get('/api/clients/:id/summary', (req, res) => {
  res.json(store.getClientSummary(req.params.id, parseRangeQuery(req)));
});

// Portfolio rollup — every client with mini KPIs, for the landing grid
app.get('/api/portfolio', (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(store.getPortfolio('default', days));
});

app.listen(PORT, () => console.log(`ARGUS Pulse running on http://localhost:${PORT}`));
