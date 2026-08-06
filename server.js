require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./lib/store');
const { fetchMetaInsights } = require('./lib/meta');
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
  const { platform, external_account_id, label, access_token } = req.body;
  if (!platform || !external_account_id) return res.status(400).json({ error: 'platform and external_account_id required' });
  const id = store.addAdAccount(req.params.clientId, { platform, external_account_id, label, access_token });
  res.json({ id });
});

// ---------- Sync (pull metrics — real if token present, mock otherwise) ----------
app.post('/api/ad-accounts/:id/sync', async (req, res) => {
  const account = store.getAdAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'ad account not found' });

  let rows, mode;
  try {
    if (account.platform === 'meta' && account.access_token) {
      const until = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      rows = await fetchMetaInsights(account.external_account_id, account.access_token, since, until);
      mode = 'live';
    } else {
      rows = generateMockMetrics(account.id);
      mode = 'mock';
    }
  } catch (err) {
    console.error('Sync failed, falling back to mock:', err.message);
    rows = generateMockMetrics(account.id);
    mode = 'mock';
  }

  store.clearMetrics(account.id);
  store.insertMetrics(account.id, rows);
  store.markSynced(account.id);

  res.json({ ok: true, mode, rowsSynced: rows.length });
});

// ---------- Metrics ----------
app.get('/api/ad-accounts/:id/metrics', (req, res) => {
  res.json(store.getMetrics(req.params.id));
});

// Cross-account overview for the whole agency
app.get('/api/overview', (req, res) => {
  res.json(store.getOverview());
});

// Combined summary for one client — KPIs, campaign table, trend series,
// merged across every ad account that client has connected
app.get('/api/clients/:id/summary', (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(store.getClientSummary(req.params.id, days));
});

// Portfolio rollup — every client with mini KPIs, for the landing grid
app.get('/api/portfolio', (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(store.getPortfolio('default', days));
});

app.listen(PORT, () => console.log(`ARGUS Pulse running on http://localhost:${PORT}`));
