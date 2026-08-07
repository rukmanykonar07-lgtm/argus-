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
  data.clients.push({
    id, tenant_id: tenant_id || 'default', name,
    status: status || 'active', notes: notes || '',
    created_at: new Date().toISOString(),
  });
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

function addAdAccount(clientId, { platform, external_account_id, label, access_token, developer_token, manager_customer_id }) {
  const id = data.nextIds.adAccount++;
  data.adAccounts.push({
    id, client_id: Number(clientId), platform, external_account_id,
    label: label || external_account_id,
    access_token: access_token || null,
    developer_token: developer_token || null,
    manager_customer_id: manager_customer_id || null,
    last_synced_at: null,
    last_sync_mode: null, // 'live' | 'mock' — set only after an actual sync, never guessed from field presence
  });
  save();
  return id;
}

function markSynced(accountId, mode) {
  const a = getAdAccount(accountId);
  if (a) { a.last_synced_at = new Date().toISOString(); a.last_sync_mode = mode; save(); }
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
      revenue: r.revenue || 0,
    });
  }
  save();
}

function getMetrics(accountId) {
  return data.dailyMetrics
    .filter(m => m.ad_account_id === Number(accountId))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Derived metric helpers ----------
function deriveRates(row) {
  return {
    ...row,
    ctr: row.impressions ? (row.clicks / row.impressions * 100) : 0,
    cpa: row.conversions ? (row.spend / row.conversions) : null,
    roas: row.spend ? (row.revenue / row.spend) : null,
  };
}

function pctChange(curr, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  if (curr === null || curr === undefined) return null;
  return ((curr - prev) / prev) * 100;
}

// Resolves a {days} shorthand or explicit {since, until} into concrete
// current-period and previous-period date boundaries.
function resolveRange({ days, since, until }) {
  const today = new Date();
  let rangeEnd = until ? new Date(until) : today;
  let rangeStart;
  if (since) {
    rangeStart = new Date(since);
  } else {
    rangeStart = new Date(rangeEnd);
    rangeStart.setDate(rangeStart.getDate() - (days || 30));
  }
  const spanMs = rangeEnd - rangeStart;
  const prevEnd = new Date(rangeStart.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - spanMs);
  return { rangeStart, rangeEnd, prevStart, prevEnd };
}

// Combines every ad account under one client into: KPI totals, a
// campaign-level table (aggregated across platforms), per-metric daily
// timeseries (for sparklines + trend chart), and platform spend breakdown.
function getClientSummary(clientId, { days = 30, since, until } = {}) {
  const accounts = getAdAccountsByClient(clientId);
  const allMetrics = accounts.flatMap(a => getMetrics(a.id).map(m => ({ ...m, platform: a.platform, account_label: a.label })));

  const { rangeStart, rangeEnd, prevStart, prevEnd } = resolveRange({ days, since, until });
  const inRange = (m, start, end) => { const d = new Date(m.date); return d >= start && d <= end; };

  const currentMetrics = allMetrics.filter(m => inRange(m, rangeStart, rangeEnd));
  const prevMetrics = allMetrics.filter(m => inRange(m, prevStart, prevEnd));

  function summarize(metrics) {
    const byCampaign = {};
    const byDate = {};
    const byPlatform = {};

    for (const m of metrics) {
      const key = `${m.campaign_name}__${m.platform}`;
      if (!byCampaign[key]) {
        byCampaign[key] = { campaign_name: m.campaign_name, platform: m.platform, spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, lastDate: m.date, firstDate: m.date };
      }
      const c = byCampaign[key];
      c.spend += m.spend; c.impressions += m.impressions; c.clicks += m.clicks;
      c.conversions += m.conversions; c.revenue += (m.revenue || 0);
      if (m.date > c.lastDate) c.lastDate = m.date;
      if (m.date < c.firstDate) c.firstDate = m.date;

      if (!byDate[m.date]) byDate[m.date] = { date: m.date, spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
      byDate[m.date].spend += m.spend;
      byDate[m.date].impressions += m.impressions;
      byDate[m.date].clicks += m.clicks;
      byDate[m.date].conversions += m.conversions;
      byDate[m.date].revenue += (m.revenue || 0);

      byPlatform[m.platform] = (byPlatform[m.platform] || 0) + m.spend;
    }

    const today = new Date();
    const staleCutoff = new Date(today); staleCutoff.setDate(staleCutoff.getDate() - 2);
    const staleCutoffStr = staleCutoff.toISOString().slice(0, 10);

    const campaigns = Object.values(byCampaign)
      .map(c => ({ ...deriveRates(c), status: c.lastDate >= staleCutoffStr ? 'active' : 'paused' }))
      .sort((a, b) => b.spend - a.spend);

    const timeseries = Object.values(byDate)
      .map(deriveRates)
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalsRaw = campaigns.reduce((acc, c) => ({
      spend: acc.spend + c.spend, impressions: acc.impressions + c.impressions,
      clicks: acc.clicks + c.clicks, conversions: acc.conversions + c.conversions,
      revenue: acc.revenue + c.revenue,
    }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 });

    return { campaigns, timeseries, totals: deriveRates(totalsRaw), platformSpend: byPlatform };
  }

  const current = summarize(currentMetrics);
  const prev = summarize(prevMetrics);

  return {
    accounts,
    campaigns: current.campaigns,
    timeseries: current.timeseries,
    platformSpend: current.platformSpend,
    totals: current.totals,
    deltas: {
      spend: pctChange(current.totals.spend, prev.totals.spend),
      clicks: pctChange(current.totals.clicks, prev.totals.clicks),
      impressions: pctChange(current.totals.impressions, prev.totals.impressions),
      ctr: pctChange(current.totals.ctr, prev.totals.ctr),
      cpa: pctChange(current.totals.cpa, prev.totals.cpa),
      revenue: pctChange(current.totals.revenue, prev.totals.revenue),
      roas: pctChange(current.totals.roas, prev.totals.roas),
    },
    _prevCampaigns: prev.campaigns, // used internally by the insights engine below
  };
}

function getPortfolio(tenantId = 'default', days = 30) {
  const clients = data.clients.filter(c => c.tenant_id === tenantId);
  return clients.map(c => {
    const summary = getClientSummary(c.id, { days });
    return {
      id: c.id, name: c.name, status: c.status,
      account_count: getAdAccountsByClient(c.id).length,
      is_live: getAdAccountsByClient(c.id).some(a => a.last_sync_mode === 'live'),
      totals: summary.totals,
    };
  }).sort((a, b) => b.totals.spend - a.totals.spend);
}

// ---------- Insights engine ----------
// Rule-based, not ML — compares each campaign's current period against its
// previous period across CTR, CPA, ROAS, and spend, then applies a small
// set of diagnostic heuristics to explain the LIKELY cause, always framed
// with an honest confidence level rather than stated as fact.
function generateInsights(clientId, { days = 30, since, until } = {}) {
  const summary = getClientSummary(clientId, { days, since, until });
  const prevByKey = {};
  for (const c of summary._prevCampaigns) prevByKey[`${c.campaign_name}__${c.platform}`] = c;

  const insights = [];

  for (const c of summary.campaigns) {
    const prev = prevByKey[`${c.campaign_name}__${c.platform}`];
    if (!prev || prev.spend < 5) continue; // not enough prior data to compare meaningfully

    const ctrChange = pctChange(c.ctr, prev.ctr);
    const cpaChange = pctChange(c.cpa, prev.cpa);
    const spendChange = pctChange(c.spend, prev.spend);
    const convChange = pctChange(c.conversions, prev.conversions);
    const impChange = pctChange(c.impressions, prev.impressions);

    // Rule 1: CPA rose significantly while CTR dropped and spend held steady
    // -> classic creative fatigue signature
    if (cpaChange !== null && cpaChange > 25 && ctrChange !== null && ctrChange < -15 && spendChange !== null && Math.abs(spendChange) < 20) {
      insights.push({
        campaign: c.campaign_name, platform: c.platform, severity: 'concern',
        confidence: 'likely',
        title: `${c.campaign_name}: cost per result climbing`,
        explanation: `CPA is up ${cpaChange.toFixed(0)}% while CTR dropped ${Math.abs(ctrChange).toFixed(0)}% — spend stayed roughly flat, so the audience is likely tuning the creative out. Likely cause: creative fatigue. Worth refreshing the ad creative or rotating in new variants.`,
      });
      continue;
    }

    // Rule 2: Impressions grew a lot but CTR dropped -> broader/emptier reach
    if (impChange !== null && impChange > 30 && ctrChange !== null && ctrChange < -20) {
      insights.push({
        campaign: c.campaign_name, platform: c.platform, severity: 'concern',
        confidence: 'possibly',
        title: `${c.campaign_name}: reach grew, engagement didn't keep up`,
        explanation: `Impressions rose ${impChange.toFixed(0)}% but CTR fell ${Math.abs(ctrChange).toFixed(0)}%. Possibly the audience widened into a less relevant segment (e.g. an expanding lookalike or broad targeting reaching further out). Worth checking if targeting settings changed recently.`,
      });
      continue;
    }

    // Rule 3: Clicks up but conversions flat/down -> funnel/landing page issue
    if (c.clicks > prev.clicks * 1.2 && convChange !== null && convChange < 5) {
      insights.push({
        campaign: c.campaign_name, platform: c.platform, severity: 'concern',
        confidence: 'unclear — worth checking manually',
        title: `${c.campaign_name}: more clicks, conversions didn't follow`,
        explanation: `Clicks are up but conversions stayed roughly flat. This usually points past the ad itself — landing page load time, an offer mismatch, or a broken conversion tracking pixel are the common causes. Not enough data here to say which for certain.`,
      });
      continue;
    }

    // Rule 4: Genuinely good news — CPA down, ROAS up
    if (cpaChange !== null && cpaChange < -15 && c.roas && prev.roas && c.roas > prev.roas) {
      insights.push({
        campaign: c.campaign_name, platform: c.platform, severity: 'good',
        confidence: 'likely',
        title: `${c.campaign_name}: efficiency improving`,
        explanation: `CPA dropped ${Math.abs(cpaChange).toFixed(0)}% and ROAS improved. This is likely the algorithm's delivery optimizing as it gathers more conversion data — a good sign to consider increasing budget here while it's working.`,
      });
      continue;
    }

    // Rule 5: Spend jumped a lot with no efficiency signal either way — flag as worth watching, not urgent
    if (spendChange !== null && spendChange > 40 && Math.abs(cpaChange || 0) < 15) {
      insights.push({
        campaign: c.campaign_name, platform: c.platform, severity: 'neutral',
        confidence: 'assume',
        title: `${c.campaign_name}: spend increased noticeably`,
        explanation: `Spend is up ${spendChange.toFixed(0)}% with CPA holding roughly steady — efficiency hasn't changed, so this is most likely a deliberate budget increase rather than a problem. Flagging so it's not a surprise on the invoice.`,
      });
    }
  }

  // Sort: concerns first (most actionable), then neutral, then good news
  const order = { concern: 0, neutral: 1, good: 2 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);
  return insights;
}

module.exports = {
  getClients, addClient, updateClient,
  getAdAccountsByClient, getAdAccount, addAdAccount, markSynced,
  clearMetrics, insertMetrics, getMetrics, getClientSummary, getPortfolio, generateInsights,
};
