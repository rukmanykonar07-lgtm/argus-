// Plain JSON-file storage. No native compilation, no build tools required —
// this has to run on any client's Windows/Mac laptop with just Node.js
// installed, nothing else.

const fs = require('fs');
const path = require('path');
const { evaluateEntity } = require('./insights');

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
    last_sync_mode: null,
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
      ad_set_name: r.ad_set_name || 'Unnamed ad set',
      ad_name: r.ad_name || 'Unnamed ad',
      date: r.date,
      spend: r.spend, impressions: r.impressions, reach: r.reach || 0,
      clicks: r.clicks, conversions: r.conversions, revenue: r.revenue || 0,
      quality_ranking: r.quality_ranking || null,
      engagement_rate_ranking: r.engagement_rate_ranking || null,
      conversion_rate_ranking: r.conversion_rate_ranking || null,
    });
  }
  save();
}

function getMetrics(accountId) {
  return data.dailyMetrics
    .filter(m => m.ad_account_id === Number(accountId))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Aggregation helpers ----------
function deriveRates(row) {
  return {
    ...row,
    ctr: row.impressions ? (row.clicks / row.impressions * 100) : 0,
    cpa: row.conversions ? (row.spend / row.conversions) : null,
    roas: row.spend ? (row.revenue / row.spend) : null,
    cpm: row.impressions ? (row.spend / row.impressions * 1000) : null,
    cpc: row.clicks ? (row.spend / row.clicks) : null,
    frequency: row.reach ? (row.impressions / row.reach) : null,
  };
}

function pctChange(curr, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  if (curr === null || curr === undefined) return null;
  return ((curr - prev) / prev) * 100;
}

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

const STALE_DAYS = 2;
function statusFor(lastDate) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - STALE_DAYS);
  return lastDate >= cutoff.toISOString().slice(0, 10) ? 'active' : 'paused';
}

function emptyAgg() { return { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0, lastDate: null }; }
function addRow(agg, m) {
  agg.spend += m.spend; agg.impressions += m.impressions; agg.reach += (m.reach || 0);
  agg.clicks += m.clicks; agg.conversions += m.conversions; agg.revenue += (m.revenue || 0);
  if (!agg.lastDate || m.date > agg.lastDate) agg.lastDate = m.date;
}

// Builds the full Campaign -> Ad Set -> Ad tree for one set of rows,
// returning both the tree and a flat date-keyed rollup for the trend
// chart / donut (which don't care about hierarchy).
function buildTree(rows) {
  const campaigns = {};
  const byDate = {};
  const byPlatform = {};

  for (const m of rows) {
    if (!campaigns[m.campaign_name]) campaigns[m.campaign_name] = { agg: emptyAgg(), adsets: {}, platform: m.platform };
    const camp = campaigns[m.campaign_name];
    addRow(camp.agg, m);

    if (!camp.adsets[m.ad_set_name]) camp.adsets[m.ad_set_name] = { agg: emptyAgg(), ads: {} };
    const adset = camp.adsets[m.ad_set_name];
    addRow(adset.agg, m);

    if (!adset.ads[m.ad_name]) adset.ads[m.ad_name] = { agg: emptyAgg(), rankings: null };
    addRow(adset.ads[m.ad_name].agg, m);
    if (m.quality_ranking || m.engagement_rate_ranking || m.conversion_rate_ranking) {
      // Rows arrive date-ascending (getMetrics sorts that way), so simply
      // overwriting on every row leaves the latest day's ranking in place
      adset.ads[m.ad_name].rankings = {
        quality: m.quality_ranking, engagement: m.engagement_rate_ranking, conversion: m.conversion_rate_ranking,
      };
    }

    if (!byDate[m.date]) byDate[m.date] = { date: m.date, spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0 };
    byDate[m.date].spend += m.spend; byDate[m.date].impressions += m.impressions; byDate[m.date].reach += (m.reach || 0);
    byDate[m.date].clicks += m.clicks; byDate[m.date].conversions += m.conversions;
    byDate[m.date].revenue += (m.revenue || 0);

    byPlatform[m.platform] = (byPlatform[m.platform] || 0) + m.spend;
  }
  return { campaigns, byDate, byPlatform };
}

function findPrev(prevTree, campaignName, adsetName, adName) {
  const camp = prevTree.campaigns[campaignName];
  if (!camp) return null;
  if (adsetName === undefined) return deriveRates(camp.agg);
  const adset = camp.adsets[adsetName];
  if (!adset) return null;
  if (adName === undefined) return deriveRates(adset.agg);
  const ad = adset.ads[adName];
  return ad ? deriveRates(ad.agg) : null;
}

function getClientSummary(clientId, { days = 30, since, until } = {}) {
  const accounts = getAdAccountsByClient(clientId);
  const allMetrics = accounts.flatMap(a => getMetrics(a.id).map(m => ({ ...m, platform: a.platform })));

  const { rangeStart, rangeEnd, prevStart, prevEnd } = resolveRange({ days, since, until });
  const inRange = (m, start, end) => { const d = new Date(m.date); return d >= start && d <= end; };

  const currentMetrics = allMetrics.filter(m => inRange(m, rangeStart, rangeEnd));
  const prevMetrics = allMetrics.filter(m => inRange(m, prevStart, prevEnd));

  const currTree = buildTree(currentMetrics);
  const prevTree = buildTree(prevMetrics);

  const campaigns = Object.entries(currTree.campaigns).map(([campName, camp]) => {
    const campCurr = deriveRates(camp.agg);
    const campPrev = findPrev(prevTree, campName);
    const campInsight = evaluateEntity(campCurr, campPrev);

    const adsets = Object.entries(camp.adsets).map(([adsetName, adset]) => {
      const adsetCurr = deriveRates(adset.agg);
      const adsetPrev = findPrev(prevTree, campName, adsetName);
      const adsetInsight = evaluateEntity(adsetCurr, adsetPrev);

      const ads = Object.entries(adset.ads).map(([adName, ad]) => {
        const adCurr = deriveRates(ad.agg);
        const adPrev = findPrev(prevTree, campName, adsetName, adName);
        const adInsight = evaluateEntity(adCurr, adPrev);
        return {
          name: adName, level: 'ad',
          spend: adCurr.spend, impressions: adCurr.impressions, reach: adCurr.reach, clicks: adCurr.clicks,
          conversions: adCurr.conversions, revenue: adCurr.revenue,
          ctr: adCurr.ctr, cpa: adCurr.cpa, roas: adCurr.roas, cpm: adCurr.cpm, cpc: adCurr.cpc, frequency: adCurr.frequency,
          status: statusFor(ad.agg.lastDate),
          insight: adInsight,
          rankings: ad.rankings,
        };
      }).sort((a, b) => b.spend - a.spend);

      return {
        name: adsetName, level: 'adset', platform: camp.platform,
        spend: adsetCurr.spend, impressions: adsetCurr.impressions, reach: adsetCurr.reach, clicks: adsetCurr.clicks,
        conversions: adsetCurr.conversions, revenue: adsetCurr.revenue,
        ctr: adsetCurr.ctr, cpa: adsetCurr.cpa, roas: adsetCurr.roas, cpm: adsetCurr.cpm, cpc: adsetCurr.cpc, frequency: adsetCurr.frequency,
        status: statusFor(adset.agg.lastDate),
        insight: adsetInsight,
        ads,
      };
    }).sort((a, b) => b.spend - a.spend);

    return {
      name: campName, level: 'campaign', platform: camp.platform,
      spend: campCurr.spend, impressions: campCurr.impressions, reach: campCurr.reach, clicks: campCurr.clicks,
      conversions: campCurr.conversions, revenue: campCurr.revenue,
      ctr: campCurr.ctr, cpa: campCurr.cpa, roas: campCurr.roas, cpm: campCurr.cpm, cpc: campCurr.cpc, frequency: campCurr.frequency,
      status: statusFor(camp.agg.lastDate),
      insight: campInsight,
      adsets,
    };
  }).sort((a, b) => b.spend - a.spend);

  const timeseries = Object.values(currTree.byDate).map(deriveRates).sort((a, b) => a.date.localeCompare(b.date));

  const totalsRaw = campaigns.reduce((acc, c) => ({
    spend: acc.spend + c.spend, impressions: acc.impressions + c.impressions, reach: acc.reach + c.reach,
    clicks: acc.clicks + c.clicks, conversions: acc.conversions + c.conversions,
    revenue: acc.revenue + c.revenue,
  }), { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0 });
  const prevTotalsRaw = Object.values(prevTree.campaigns).reduce((acc, c) => ({
    spend: acc.spend + c.agg.spend, impressions: acc.impressions + c.agg.impressions, reach: acc.reach + c.agg.reach,
    clicks: acc.clicks + c.agg.clicks, conversions: acc.conversions + c.agg.conversions,
    revenue: acc.revenue + c.agg.revenue,
  }), { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0 });

  const totals = deriveRates(totalsRaw);
  const prevTotals = deriveRates(prevTotalsRaw);

  const brandInsight = evaluateEntity(totals, prevTotals.spend > 0 ? prevTotals : null);

  return {
    accounts, campaigns, timeseries, totals,
    platformSpend: currTree.byPlatform,
    brandInsight,
    deltas: {
      spend: pctChange(totals.spend, prevTotals.spend),
      clicks: pctChange(totals.clicks, prevTotals.clicks),
      impressions: pctChange(totals.impressions, prevTotals.impressions),
      ctr: pctChange(totals.ctr, prevTotals.ctr),
      cpa: pctChange(totals.cpa, prevTotals.cpa),
      revenue: pctChange(totals.revenue, prevTotals.revenue),
      roas: pctChange(totals.roas, prevTotals.roas),
    },
  };
}

const SEVERITY_RANK = { concern: 0, neutral: 1, unknown: 2, good: 3, perfect: 4 };

function getPortfolio(tenantId = 'default', days = 30) {
  const clients = data.clients.filter(c => c.tenant_id === tenantId);
  return clients.map(c => {
    const summary = getClientSummary(c.id, { days });
    return {
      id: c.id, name: c.name, status: c.status,
      account_count: getAdAccountsByClient(c.id).length,
      is_live: getAdAccountsByClient(c.id).some(a => a.last_sync_mode === 'live'),
      totals: summary.totals,
      brandInsight: summary.brandInsight,
      // Count of concerning items at any level (campaign/adset/ad) beneath
      // this client — gives the portfolio card a real number, not just a mood
      concernCount: countConcerns(summary.campaigns),
    };
  }).sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.brandInsight.severity] - SEVERITY_RANK[b.brandInsight.severity];
    return rankDiff !== 0 ? rankDiff : b.totals.spend - a.totals.spend;
  });
}

function countConcerns(campaigns) {
  let count = 0;
  for (const c of campaigns) {
    if (c.insight.severity === 'concern') count++;
    for (const as of c.adsets) {
      if (as.insight.severity === 'concern') count++;
      for (const ad of as.ads) if (ad.insight.severity === 'concern') count++;
    }
  }
  return count;
}

module.exports = {
  getClients, addClient, updateClient,
  getAdAccountsByClient, getAdAccount, addAdAccount, markSynced,
  clearMetrics, insertMetrics, getMetrics, getClientSummary, getPortfolio,
};
