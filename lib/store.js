// Plain JSON-file storage. No native compilation, no build tools required —
// this has to run on any client's Windows/Mac laptop with just Node.js
// installed, nothing else.

const fs = require('fs');
const path = require('path');
const { evaluateEntity, evaluateGoal, auditEntity, evaluateRule } = require('./insights');
const { encrypt, decrypt } = require('./crypto');
const { hashPassword, verifyPassword } = require('./auth');

const DATA_FILE = path.join(__dirname, '..', 'argus_pulse_data.json');

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('Data file corrupted, starting fresh:', e.message);
    }
  }
  return { clients: [], adAccounts: [], dailyMetrics: [], searchVisibility: {}, users: [], rules: [], recommendedActions: [], nextIds: { client: 1, adAccount: 1, metric: 1, user: 1, rule: 1, action: 1 } };
}

let data = load();
// Back-compat: data files saved before these existed won't have them
if (!data.searchVisibility) data.searchVisibility = {};
if (!data.users) data.users = [];
if (!data.rules) data.rules = [];
if (!data.recommendedActions) data.recommendedActions = [];
if (!data.nextIds.user) data.nextIds.user = 1;
if (!data.nextIds.rule) data.nextIds.rule = 1;
if (!data.nextIds.action) data.nextIds.action = 1;

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---------- Users (auth) ----------
// ponytail: two roles, not a permission matrix — 'admin' can manage users,
// 'member' can do everything else. Nobody's asked for per-client access
// scoping; build that when someone actually needs it, not speculatively.
function userCount() { return data.users.length; }

function redactUser(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

function getUsers() { return data.users.map(redactUser); }

function getUserByUsername(username) {
  return data.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
}

function getUserById(id) {
  return data.users.find(u => u.id === Number(id));
}

function addUser({ username, password, role }) {
  if (getUserByUsername(username)) throw Object.assign(new Error('username already taken'), { status: 409 });
  const id = data.nextIds.user++;
  // First user ever created is always admin, regardless of what's passed —
  // there must always be at least one account that can manage other users.
  const finalRole = data.users.length === 0 ? 'admin' : (role === 'admin' ? 'admin' : 'member');
  data.users.push({ id, username, password_hash: hashPassword(password), role: finalRole, created_at: new Date().toISOString() });
  save();
  return id;
}

function verifyUserPassword(username, password) {
  const u = getUserByUsername(username);
  if (!u) return null;
  return verifyPassword(password, u.password_hash) ? u : null;
}

function deleteUser(id, requestingUserId) {
  if (Number(id) === Number(requestingUserId)) throw Object.assign(new Error("can't delete your own account while logged in as it"), { status: 400 });
  const before = data.users.length;
  data.users = data.users.filter(u => u.id !== Number(id));
  if (data.users.length === before) return false;
  save();
  return true;
}

// ---------- Rules & recommended actions ----------
// Deliberately recommend-only — evaluating a rule never calls Meta's or
// Google's write API to actually pause a campaign or change a budget.
// It creates a recommendation a human reviews and acts on manually.
// Auto-executing spend changes unattended is a real-money risk if a rule
// or a metric sync has a bug; that's a distinct, much higher-stakes
// feature than what's built here, not a natural extension of it.
const ALLOWED_METRICS = ['cpa', 'roas', 'ctr', 'frequency', 'spend', 'conversions'];

function addRule(clientId, { name, metric, operator, value, action }) {
  if (!ALLOWED_METRICS.includes(metric)) throw Object.assign(new Error(`metric must be one of: ${ALLOWED_METRICS.join(', ')}`), { status: 400 });
  if (!['>', '<'].includes(operator)) throw Object.assign(new Error("operator must be '>' or '<'"), { status: 400 });
  const id = data.nextIds.rule++;
  data.rules.push({
    id, client_id: Number(clientId), name: name || `${metric} ${operator} ${value}`,
    metric, operator, value: Number(value), action: action || 'Review this campaign',
    enabled: true, created_at: new Date().toISOString(),
  });
  save();
  return id;
}

function getRulesByClient(clientId) {
  return data.rules.filter(r => r.client_id === Number(clientId));
}

function deleteRule(id) {
  const before = data.rules.length;
  data.rules = data.rules.filter(r => r.id !== Number(id));
  if (data.rules.length === before) return false;
  save();
  return true;
}

// Called from getClientSummary with the campaigns it already built —
// no separate evaluation pass, reuses totals that were computed anyway.
// Dedupes against ANY action for this rule+campaign created TODAY, not
// just open ones — deduping only on "open" meant dismissing an action
// just recreated it on the next summary fetch, since the dismissed one
// no longer counted as "existing". Once resolved today it stays resolved
// for the rest of today; if the condition is still true tomorrow it
// surfaces again — same daily cadence the alerts webhook already uses.
function evaluateRulesForClient(clientId, campaigns) {
  const rules = getRulesByClient(clientId).filter(r => r.enabled);
  if (!rules.length) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const rule of rules) {
    for (const camp of campaigns) {
      if (!evaluateRule(camp, rule)) continue;
      const existsToday = data.recommendedActions.some(a =>
        a.rule_id === rule.id && a.campaign_name === camp.name && a.created_at.slice(0, 10) === today
      );
      if (existsToday) continue;
      data.recommendedActions.push({
        id: data.nextIds.action++, client_id: Number(clientId), rule_id: rule.id,
        rule_name: rule.name, campaign_name: camp.name, action: rule.action,
        message: `"${camp.name}" — ${rule.metric} ${rule.operator} ${rule.value} (currently ${typeof camp[rule.metric] === 'number' ? camp[rule.metric].toFixed(2) : camp[rule.metric]})`,
        status: 'open', created_at: new Date().toISOString(),
      });
    }
  }
  save();
}

function getOpenActions(clientId) {
  return data.recommendedActions.filter(a => a.client_id === Number(clientId) && a.status === 'open');
}

function resolveAction(id, status) {
  const a = data.recommendedActions.find(a => a.id === Number(id));
  if (!a) return false;
  a.status = status; // 'dismissed' or 'done'
  a.resolved_at = new Date().toISOString();
  save();
  return true;
}

// ---------- Clients ----------
// API-facing: never sends token fields to the frontend. Tokens only exist
// decrypted in-process for the sync call that needs them (see getAdAccount).
function redactAccount(a) {
  const { access_token, developer_token, refresh_token, client_secret, ...safe } = a;
  return {
    ...safe,
    has_access_token: !!access_token,
    has_developer_token: !!developer_token,
    has_refresh_token: !!refresh_token,
  };
}

function getClients(tenantId = 'default') {
  return data.clients
    .filter(c => c.tenant_id === tenantId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(c => ({ ...c, ad_accounts: getAdAccountsByClient(c.id).map(redactAccount) }));
}

function getClientById(id) {
  return data.clients.find(c => c.id === Number(id));
}

function addClient({ name, status, notes, tenant_id, target_cpa, target_roas, monthly_budget, webhook_url, management_fee_pct }) {
  const id = data.nextIds.client++;
  data.clients.push({
    id, tenant_id: tenant_id || 'default', name,
    status: status || 'active', notes: notes || '',
    // Goals are optional and per-client, not a generic fixed threshold —
    // this is what lets the insight engine judge a client against what
    // THEY care about instead of a one-size-fits-all percentage.
    target_cpa: target_cpa ? Number(target_cpa) : null,
    target_roas: target_roas ? Number(target_roas) : null,
    monthly_budget: monthly_budget ? Number(monthly_budget) : null,
    webhook_url: webhook_url || null,
    // % markup the agency bills on top of ad spend — a flat, single
    // number, not a tiered/volume-based fee schedule. Build tiers if a
    // client actually needs them; most agencies just quote one %.
    management_fee_pct: management_fee_pct ? Number(management_fee_pct) : null,
    created_at: new Date().toISOString(),
  });
  save();
  return id;
}

function updateClient(id, { status, notes, target_cpa, target_roas, monthly_budget, webhook_url, management_fee_pct }) {
  const c = data.clients.find(c => c.id === Number(id));
  if (!c) return false;
  if (status !== undefined) c.status = status;
  if (notes !== undefined) c.notes = notes;
  if (target_cpa !== undefined) c.target_cpa = target_cpa === null || target_cpa === '' ? null : Number(target_cpa);
  if (target_roas !== undefined) c.target_roas = target_roas === null || target_roas === '' ? null : Number(target_roas);
  if (monthly_budget !== undefined) c.monthly_budget = monthly_budget === null || monthly_budget === '' ? null : Number(monthly_budget);
  if (webhook_url !== undefined) c.webhook_url = webhook_url === '' ? null : webhook_url;
  if (management_fee_pct !== undefined) c.management_fee_pct = management_fee_pct === null || management_fee_pct === '' ? null : Number(management_fee_pct);
  save();
  return true;
}


// ---------- Ad accounts ----------
function getAdAccountsByClient(clientId) {
  return data.adAccounts.filter(a => a.client_id === Number(clientId));
}

// Internal use only (sync logic) — returns decrypted tokens. Never expose
// this object directly over the API; use redactAccount() for that.
function getAdAccount(id) {
  const a = data.adAccounts.find(a => a.id === Number(id));
  if (!a) return a;
  return {
    ...a,
    access_token: decrypt(a.access_token),
    developer_token: decrypt(a.developer_token),
    refresh_token: decrypt(a.refresh_token),
    client_secret: decrypt(a.client_secret),
  };
}

function addAdAccount(clientId, { platform, external_account_id, label, access_token, developer_token, manager_customer_id, refresh_token, client_id, client_secret }) {
  const id = data.nextIds.adAccount++;
  data.adAccounts.push({
    id, client_id: Number(clientId), platform, external_account_id,
    label: label || external_account_id,
    access_token: encrypt(access_token || null),
    developer_token: encrypt(developer_token || null),
    manager_customer_id: manager_customer_id || null,
    // Google OAuth refresh flow — client_id/client_secret are the caller's
    // own OAuth app credentials, refresh_token is long-lived. When present,
    // sync exchanges these for a fresh access_token automatically instead
    // of needing a manually re-pasted token every ~hour.
    google_client_id: client_id || null,
    client_secret: encrypt(client_secret || null),
    refresh_token: encrypt(refresh_token || null),
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
      engagement: r.engagement || 0, video_views: r.video_views || 0, link_clicks: r.link_clicks || 0,
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

// ---------- Search visibility (Google Search Impression Share) ----------
// Campaign-level snapshot, not daily history — keyed by ad account, then
// campaign name, overwritten wholesale on every sync.
function setSearchVisibility(accountId, visibilityByCampaign) {
  data.searchVisibility[Number(accountId)] = visibilityByCampaign;
  save();
}

function getSearchVisibility(accountId, campaignName) {
  return data.searchVisibility[Number(accountId)]?.[campaignName] || null;
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
    engagement_rate: row.impressions ? ((row.engagement || 0) / row.impressions * 100) : null,
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

// Budget pacing — "will this client blow past or undershoot their monthly
// number at this rate." Competing tools (Revealbot, Shape.io) treat this
// as a whole product category; this is the lightweight version: no
// day-of-week weighting, just calendar-linear pacing, but it answers the
// actual question an agency owner has mid-month. Returns null when the
// client hasn't set a monthly budget — nothing to pace against.
function getBudgetPacing(clientId, monthlyBudget) {
  if (!monthlyBudget) return null;
  const accounts = getAdAccountsByClient(clientId);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  let spendMTD = 0;
  for (const a of accounts) {
    for (const m of getMetrics(a.id)) {
      const d = new Date(m.date);
      if (d >= monthStart && d <= now) spendMTD += m.spend;
    }
  }

  const pctOfMonthElapsed = (dayOfMonth / daysInMonth) * 100;
  const pctOfBudgetUsed = (spendMTD / monthlyBudget) * 100;
  const projectedSpend = dayOfMonth > 0 ? (spendMTD / dayOfMonth) * daysInMonth : 0;
  const paceDiff = pctOfBudgetUsed - pctOfMonthElapsed; // positive = overpacing

  let status = 'on-track';
  if (paceDiff > 8) status = 'overpacing';
  else if (paceDiff < -8) status = 'underpacing';

  return { monthlyBudget, spendMTD, projectedSpend, daysInMonth, dayOfMonth, pctOfMonthElapsed, pctOfBudgetUsed, status };
}

function emptyAgg() { return { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0, engagement: 0, video_views: 0, link_clicks: 0, lastDate: null }; }
function addRow(agg, m) {
  agg.spend += m.spend; agg.impressions += m.impressions; agg.reach += (m.reach || 0);
  agg.clicks += m.clicks; agg.conversions += m.conversions; agg.revenue += (m.revenue || 0);
  agg.engagement += (m.engagement || 0); agg.video_views += (m.video_views || 0); agg.link_clicks += (m.link_clicks || 0);
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
    // Keyed by platform+name, not name alone — otherwise a Meta campaign
    // and a Google campaign that happen to share a name (very common:
    // "Brand Search" run on both) silently merge into one node and one
    // platform's data disappears. camp.name keeps the clean display name.
    const campKey = `${m.platform}::${m.campaign_name}`;
    if (!campaigns[campKey]) campaigns[campKey] = { name: m.campaign_name, agg: emptyAgg(), adsets: {}, platform: m.platform, ad_account_id: m.ad_account_id };
    const camp = campaigns[campKey];
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

    if (!byDate[m.date]) byDate[m.date] = { date: m.date, spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0, engagement: 0, video_views: 0, link_clicks: 0 };
    byDate[m.date].spend += m.spend; byDate[m.date].impressions += m.impressions; byDate[m.date].reach += (m.reach || 0);
    byDate[m.date].clicks += m.clicks; byDate[m.date].conversions += m.conversions;
    byDate[m.date].revenue += (m.revenue || 0);
    byDate[m.date].engagement += (m.engagement || 0); byDate[m.date].video_views += (m.video_views || 0); byDate[m.date].link_clicks += (m.link_clicks || 0);

    byPlatform[m.platform] = (byPlatform[m.platform] || 0) + m.spend;
  }
  return { campaigns, byDate, byPlatform };
}

function findPrev(prevTree, campKey, adsetName, adName) {
  const camp = prevTree.campaigns[campKey];
  if (!camp) return null;
  if (adsetName === undefined) return deriveRates(camp.agg);
  const adset = camp.adsets[adsetName];
  if (!adset) return null;
  if (adName === undefined) return deriveRates(adset.agg);
  const ad = adset.ads[adName];
  return ad ? deriveRates(ad.agg) : null;
}

function getClientSummary(clientId, { days = 30, since, until, platform } = {}) {
  const client = getClientById(clientId);
  const accounts = getAdAccountsByClient(clientId);
  let allMetrics = accounts.flatMap(a => getMetrics(a.id).map(m => ({ ...m, platform: a.platform })));
  // Platform tab filtering — this is what actually makes "Meta" vs "Google"
  // tabs show different numbers instead of the same combined totals for both
  if (platform && platform !== 'all') allMetrics = allMetrics.filter(m => m.platform === platform);

  const { rangeStart, rangeEnd, prevStart, prevEnd } = resolveRange({ days, since, until });
  const inRange = (m, start, end) => { const d = new Date(m.date); return d >= start && d <= end; };

  const currentMetrics = allMetrics.filter(m => inRange(m, rangeStart, rangeEnd));
  const prevMetrics = allMetrics.filter(m => inRange(m, prevStart, prevEnd));

  const currTree = buildTree(currentMetrics);
  const prevTree = buildTree(prevMetrics);

  const campaigns = Object.entries(currTree.campaigns).map(([campKey, camp]) => {
    const campName = camp.name;
    const campCurr = deriveRates(camp.agg);
    const campPrev = findPrev(prevTree, campKey);
    const campInsight = evaluateEntity(campCurr, campPrev);
    const searchVisibility = camp.platform === 'google' ? getSearchVisibility(camp.ad_account_id, campName) : null;
    const auditFindings = auditEntity(campCurr, searchVisibility);

    const adsets = Object.entries(camp.adsets).map(([adsetName, adset]) => {
      const adsetCurr = deriveRates(adset.agg);
      const adsetPrev = findPrev(prevTree, campKey, adsetName);
      const adsetInsight = evaluateEntity(adsetCurr, adsetPrev);

      const ads = Object.entries(adset.ads).map(([adName, ad]) => {
        const adCurr = deriveRates(ad.agg);
        const adPrev = findPrev(prevTree, campKey, adsetName, adName);
        const adInsight = evaluateEntity(adCurr, adPrev);
        return {
          name: adName, level: 'ad',
          spend: adCurr.spend, impressions: adCurr.impressions, reach: adCurr.reach, clicks: adCurr.clicks,
          conversions: adCurr.conversions, revenue: adCurr.revenue,
          ctr: adCurr.ctr, cpa: adCurr.cpa, roas: adCurr.roas, cpm: adCurr.cpm, cpc: adCurr.cpc, frequency: adCurr.frequency,
          engagement: adCurr.engagement, video_views: adCurr.video_views, link_clicks: adCurr.link_clicks, engagement_rate: adCurr.engagement_rate,
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
        engagement: adsetCurr.engagement, video_views: adsetCurr.video_views, link_clicks: adsetCurr.link_clicks, engagement_rate: adsetCurr.engagement_rate,
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
      engagement: campCurr.engagement, video_views: campCurr.video_views, link_clicks: campCurr.link_clicks, engagement_rate: campCurr.engagement_rate,
      status: statusFor(camp.agg.lastDate),
      insight: campInsight,
      auditFindings,
      searchVisibility,
      adsets,
    };
  }).sort((a, b) => b.spend - a.spend);

  const timeseries = Object.values(currTree.byDate).map(deriveRates).sort((a, b) => a.date.localeCompare(b.date));

  const totalsRaw = campaigns.reduce((acc, c) => ({
    spend: acc.spend + c.spend, impressions: acc.impressions + c.impressions, reach: acc.reach + c.reach,
    clicks: acc.clicks + c.clicks, conversions: acc.conversions + c.conversions,
    revenue: acc.revenue + c.revenue,
    engagement: acc.engagement + (c.engagement || 0), video_views: acc.video_views + (c.video_views || 0), link_clicks: acc.link_clicks + (c.link_clicks || 0),
  }), { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0, engagement: 0, video_views: 0, link_clicks: 0 });
  const prevTotalsRaw = Object.values(prevTree.campaigns).reduce((acc, c) => ({
    spend: acc.spend + c.agg.spend, impressions: acc.impressions + c.agg.impressions, reach: acc.reach + c.agg.reach,
    clicks: acc.clicks + c.agg.clicks, conversions: acc.conversions + c.agg.conversions,
    revenue: acc.revenue + c.agg.revenue,
    engagement: acc.engagement + (c.agg.engagement || 0), video_views: acc.video_views + (c.agg.video_views || 0), link_clicks: acc.link_clicks + (c.agg.link_clicks || 0),
  }), { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, revenue: 0, engagement: 0, video_views: 0, link_clicks: 0 });

  const totals = deriveRates(totalsRaw);
  const prevTotals = deriveRates(prevTotalsRaw);

  const brandInsight = evaluateEntity(totals, prevTotals.spend > 0 ? prevTotals : null);
  const goalInsight = client ? evaluateGoal(totals, { target_cpa: client.target_cpa, target_roas: client.target_roas }) : null;
  const pacing = client ? getBudgetPacing(clientId, client.monthly_budget) : null;
  // Flat % of period spend — matches management_fee_pct's own scope (one
  // number, no tiers). Null when the client has no fee set, not 0 — a
  // client actively being billed 0% and a client with no fee configured
  // yet are different states and shouldn't render the same in the UI.
  const managementFee = client && client.management_fee_pct
    ? { pct: client.management_fee_pct, amount: totals.spend * (client.management_fee_pct / 100) }
    : null;
  if (client) evaluateRulesForClient(clientId, campaigns);
  const recommendedActions = client ? getOpenActions(clientId) : [];

  // Aggregate Search Impression Share across whatever Google campaigns
  // have it, so the Google tab can show one summary diagnostic instead of
  // making the marketer open every campaign row individually
  const svCampaigns = campaigns.filter(c => c.searchVisibility);
  const searchVisibilityAvg = svCampaigns.length ? {
    search_impression_share: svCampaigns.reduce((s, c) => s + c.searchVisibility.search_impression_share, 0) / svCampaigns.length,
    search_rank_lost_impression_share: svCampaigns.reduce((s, c) => s + c.searchVisibility.search_rank_lost_impression_share, 0) / svCampaigns.length,
    search_budget_lost_impression_share: svCampaigns.reduce((s, c) => s + c.searchVisibility.search_budget_lost_impression_share, 0) / svCampaigns.length,
  } : null;

  return {
    accounts, campaigns, timeseries, totals,
    platformSpend: currTree.byPlatform,
    brandInsight, goalInsight, pacing, managementFee, recommendedActions, searchVisibilityAvg,
    deltas: {
      spend: pctChange(totals.spend, prevTotals.spend),
      clicks: pctChange(totals.clicks, prevTotals.clicks),
      impressions: pctChange(totals.impressions, prevTotals.impressions),
      ctr: pctChange(totals.ctr, prevTotals.ctr),
      cpa: pctChange(totals.cpa, prevTotals.cpa),
      revenue: pctChange(totals.revenue, prevTotals.revenue),
      roas: pctChange(totals.roas, prevTotals.roas),
      conversions: pctChange(totals.conversions, prevTotals.conversions),
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
  getClients, getClientById, addClient, updateClient,
  getAdAccountsByClient, getAdAccount, addAdAccount, markSynced,
  clearMetrics, insertMetrics, getMetrics, getClientSummary, getPortfolio,
  setSearchVisibility, getSearchVisibility,
  userCount, getUsers, getUserById, addUser, verifyUserPassword, deleteUser,
  addRule, getRulesByClient, deleteRule, resolveAction,
};
