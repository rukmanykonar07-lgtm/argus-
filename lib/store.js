// Plain JSON-file storage. No native compilation, no build tools required —
// this has to run on any client's Windows/Mac laptop with just Node.js
// installed, nothing else. Fine for this data volume (an agency's clients
// and daily metrics, not big-data scale).

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'argus_pulse_data.json');

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('Data file corrupted, starting fresh:', e.message);
    }
  }
  return { clients: [], adAccounts: [], dailyMetrics: [], nextIds: { client: 1, adAccount: 1, metric: 1 } };
}

let data = load();

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---------- Clients ----------
function getClients(tenantId = 'default') {
  return data.clients
    .filter(c => c.tenant_id === tenantId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(c => ({ ...c, ad_accounts: getAdAccountsByClient(c.id) }));
}

function addClient({ name, status, notes, tenant_id }) {
  const id = data.nextIds.client++;
  const client = {
    id,
    tenant_id: tenant_id || 'default',
    name,
    status: status || 'active',
    notes: notes || '',
    created_at: new Date().toISOString(),
  };
  data.clients.push(client);
  save();
  return id;
}

function updateClient(id, { status, notes }) {
  const c = data.clients.find(c => c.id === Number(id));
  if (!c) return false;
  if (status !== undefined) c.status = status;
  if (notes !== undefined) c.notes = notes;
  save();
  return true;
}

// ---------- Ad accounts ----------
function getAdAccountsByClient(clientId) {
  return data.adAccounts.filter(a => a.client_id === Number(clientId));
}

function getAdAccount(id) {
  return data.adAccounts.find(a => a.id === Number(id));
}

function addAdAccount(clientId, { platform, external_account_id, label, access_token }) {
  const id = data.nextIds.adAccount++;
  data.adAccounts.push({
    id,
    client_id: Number(clientId),
    platform,
    external_account_id,
    label: label || external_account_id,
    access_token: access_token || null,
    connected: !!access_token,
    last_synced_at: null,
  });
  save();
  return id;
}

function markSynced(accountId) {
  const a = getAdAccount(accountId);
  if (a) { a.last_synced_at = new Date().toISOString(); save(); }
}

// ---------- Metrics ----------
function clearMetrics(accountId) {
  data.dailyMetrics = data.dailyMetrics.filter(m => m.ad_account_id !== Number(accountId));
}

function insertMetrics(accountId, rows) {
  for (const r of rows) {
    data.dailyMetrics.push({
      id: data.nextIds.metric++,
      ad_account_id: Number(accountId),
      campaign_name: r.campaign_name,
      date: r.date,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
    });
  }
  save();
}

function getMetrics(accountId) {
  return data.dailyMetrics
    .filter(m => m.ad_account_id === Number(accountId))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function getOverview(tenantId = 'default') {
  const clients = data.clients.filter(c => c.tenant_id === tenantId);
  const rows = [];
  for (const c of clients) {
    for (const a of getAdAccountsByClient(c.id)) {
      const metrics = getMetrics(a.id);
      rows.push({
        client_id: c.id,
        client_name: c.name,
        account_id: a.id,
        platform: a.platform,
        label: a.label,
        last_synced_at: a.last_synced_at,
        total_spend: metrics.reduce((s, m) => s + m.spend, 0),
        total_clicks: metrics.reduce((s, m) => s + m.clicks, 0),
        total_impressions: metrics.reduce((s, m) => s + m.impressions, 0),
        total_conversions: metrics.reduce((s, m) => s + m.conversions, 0),
      });
    }
  }
  return rows.sort((a, b) => b.total_spend - a.total_spend);
}

// Combines every ad account under one client into: KPI totals, a
// campaign-level table (aggregated across platforms), and a daily
// timeseries for the trend chart. This is what the client detail
// view in the dashboard renders.
function getClientSummary(clientId, days = 30) {
  const accounts = getAdAccountsByClient(clientId);
  const allMetrics = accounts.flatMap(a => getMetrics(a.id).map(m => ({ ...m, platform: a.platform, account_label: a.label })));

  const today = new Date();
  const rangeStart = new Date(today); rangeStart.setDate(rangeStart.getDate() - days);
  const prevStart = new Date(rangeStart); prevStart.setDate(prevStart.getDate() - days);

  const inRange = m => new Date(m.date) >= rangeStart && new Date(m.date) <= today;
  const inPrevRange = m => new Date(m.date) >= prevStart && new Date(m.date) < rangeStart;

  const currentMetrics = allMetrics.filter(inRange);
  const prevMetrics = allMetrics.filter(inPrevRange);

  function summarize(metrics) {
    const byCampaign = {};
    const byDate = {};
    for (const m of metrics) {
      const key = `${m.campaign_name}__${m.platform}`;
      if (!byCampaign[key]) {
        byCampaign[key] = { campaign_name: m.campaign_name, platform: m.platform, spend: 0, impressions: 0, clicks: 0, conversions: 0, lastDate: m.date };
      }
      byCampaign[key].spend += m.spend;
      byCampaign[key].impressions += m.impressions;
      byCampaign[key].clicks += m.clicks;
      byCampaign[key].conversions += m.conversions;
      if (m.date > byCampaign[key].lastDate) byCampaign[key].lastDate = m.date;

      if (!byDate[m.date]) byDate[m.date] = { date: m.date, spend: 0, clicks: 0 };
      byDate[m.date].spend += m.spend;
      byDate[m.date].clicks += m.clicks;
    }
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 2);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const campaigns = Object.values(byCampaign).map(c => ({
      ...c,
      ctr: c.impressions ? (c.clicks / c.impressions * 100) : 0,
      cpa: c.conversions ? (c.spend / c.conversions) : null,
      status: c.lastDate >= yesterdayStr ? 'active' : 'paused',
    })).sort((a, b) => b.spend - a.spend);

    const timeseries = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    const totals = campaigns.reduce((acc, c) => ({
      spend: acc.spend + c.spend,
      impressions: acc.impressions + c.impressions,
      clicks: acc.clicks + c.clicks,
      conversions: acc.conversions + c.conversions,
    }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });

    return {
      campaigns, timeseries,
      totals: {
        ...totals,
        ctr: totals.impressions ? (totals.clicks / totals.impressions * 100) : 0,
        cpa: totals.conversions ? (totals.spend / totals.conversions) : null,
      },
    };
  }

  const current = summarize(currentMetrics);
  const prev = summarize(prevMetrics);

  function pctChange(curr, prev) {
    if (!prev) return null;
    return ((curr - prev) / prev) * 100;
  }

  return {
    accounts,
    campaigns: current.campaigns,
    timeseries: current.timeseries,
    totals: current.totals,
    deltas: {
      spend: pctChange(current.totals.spend, prev.totals.spend),
      clicks: pctChange(current.totals.clicks, prev.totals.clicks),
      impressions: pctChange(current.totals.impressions, prev.totals.impressions),
      ctr: pctChange(current.totals.ctr, prev.totals.ctr),
      cpa: pctChange(current.totals.cpa, prev.totals.cpa),
    },
  };
}

function getPortfolio(tenantId = 'default', days = 30) {
  const clients = data.clients.filter(c => c.tenant_id === tenantId);
  return clients.map(c => {
    const summary = getClientSummary(c.id, days);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      account_count: getAdAccountsByClient(c.id).length,
      is_live: getAdAccountsByClient(c.id).some(a => a.connected),
      totals: summary.totals,
    };
  }).sort((a, b) => b.totals.spend - a.totals.spend);
}

module.exports = {
  getClients, addClient, updateClient,
  getAdAccountsByClient, getAdAccount, addAdAccount, markSynced,
  clearMetrics, insertMetrics, getMetrics, getOverview, getClientSummary, getPortfolio,
};
