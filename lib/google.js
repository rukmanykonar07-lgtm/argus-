const fetch = require('node-fetch');

// Exchanges a long-lived refresh_token for a fresh ~1hr access_token right
// before sync, using the caller's own OAuth app credentials. This is the
// piece the README flagged as missing — without it, someone has to manually
// re-paste a Google access token before every single sync. With a refresh
// token + client_id + client_secret on file, sync just works, same as Meta.
async function getAccessTokenFromRefreshToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Google OAuth refresh failed: ${data.error_description || data.error}`);
  return data.access_token;
}

// Customer IDs should only ever be digits (with optional dashes, already
// stripped by the caller). Anything else means a typo or paste error —
// better to fail with a clear message here than send a malformed URL to
// Google's API and get back a confusing error.
function assertValidCustomerId(id, label) {
  if (!/^\d+$/.test(id)) {
    throw new Error(`${label} must be numeric (digits only, dashes ok) — got "${id}"`);
  }
}

// Google Ads API needs THREE things Meta doesn't: a developer token
// (agency-wide, from your MCC's API Center), the OAuth access token, and
// a login-customer-id header (your MCC's ID) alongside the actual client
// account's customer ID. GAQL is the query language — SQL-like.
//
// IMPORTANT LIMITATION, stated honestly: Google OAuth access tokens
// expire in about 1 hour. Meta's System User tokens don't expire on a
// timer, so paste-once-and-forget works there. Here it doesn't — this
// pulls live data if the token is still valid at sync time, but a
// production setup needs a refresh-token flow (storing a client_id +
// client_secret + refresh_token, exchanging for a fresh access token
// before every sync) which isn't built yet. For now: paste a fresh
// access token before each sync, or wire up the refresh flow next.
async function fetchGoogleAdsInsights(customerId, accessToken, developerToken, managerCustomerId, sinceDate, untilDate) {
  const chunks = getWeekChunks(sinceDate, untilDate);
  const allRows = [];
  const cleanCustomerId = customerId.replace(/-/g, '');
  const cleanManagerId = (managerCustomerId || '').replace(/-/g, '');
  assertValidCustomerId(cleanCustomerId, 'Customer ID');
  if (cleanManagerId) assertValidCustomerId(cleanManagerId, 'Manager (MCC) Customer ID');

  for (const chunk of chunks) {
    // ad_group_ad gives us the full hierarchy in one query: campaign,
    // ad group (Google's equivalent of an "ad set"), and the individual ad
    const query = `
      SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name,
             segments.date, metrics.cost_micros, metrics.impressions,
             metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM ad_group_ad
      WHERE segments.date BETWEEN '${chunk.since}' AND '${chunk.until}'
        AND campaign.status != 'REMOVED'
    `.trim();

    const url = `https://googleads.googleapis.com/v17/customers/${cleanCustomerId}/googleAds:searchStream`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        ...(cleanManagerId ? { 'login-customer-id': cleanManagerId } : {}),
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    if (data.error) throw new Error(`Google Ads API error: ${data.error.message || JSON.stringify(data.error)}`);
    if (Array.isArray(data) && data[0]?.error) throw new Error(`Google Ads API error: ${data[0].error.message}`);

    const batches = Array.isArray(data) ? data : [data];
    for (const batch of batches) {
      for (const row of batch.results || []) {
        // Not every ad type exposes ad.name (e.g. some Responsive Search
        // Ads) — fall back to the ad ID so nothing silently disappears
        const adLabel = row.adGroupAd?.ad?.name || (row.adGroupAd?.ad?.id ? `Ad ${row.adGroupAd.ad.id}` : 'Unnamed ad');
        allRows.push({
          campaign_name: row.campaign?.name || 'Unknown campaign',
          ad_set_name: row.adGroup?.name || 'Unknown ad group',
          ad_name: adLabel,
          date: row.segments?.date,
          spend: Number(row.metrics?.costMicros || 0) / 1e6,
          impressions: Number(row.metrics?.impressions || 0),
          clicks: Number(row.metrics?.clicks || 0),
          conversions: Number(row.metrics?.conversions || 0),
          revenue: Number(row.metrics?.conversionsValue || 0),
        });
      }
    }
  }
  return allRows;
}

function getWeekChunks(since, until) {
  const chunks = [];
  let cursor = new Date(since);
  const end = new Date(until);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + 6);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({
      since: cursor.toISOString().slice(0, 10),
      until: actualEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(actualEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

// Search Impression Share only exists at campaign level (not the ad_group_ad
// level query above), and only for Search/Shopping/PMax campaigns — this is
// Google's own "why aren't we showing up" signal, split into two causes:
// search_rank_lost_impression_share (bid too low / Quality Score problem)
// vs search_budget_lost_impression_share (budget capped). Separate,
// lightweight query, best-effort — a campaign-level snapshot (latest value),
// not daily history like the metrics above.
async function fetchSearchVisibility(customerId, accessToken, developerToken, managerCustomerId) {
  const cleanCustomerId = customerId.replace(/-/g, '');
  const cleanManagerId = (managerCustomerId || '').replace(/-/g, '');
  assertValidCustomerId(cleanCustomerId, 'Customer ID');
  if (cleanManagerId) assertValidCustomerId(cleanManagerId, 'Manager (MCC) Customer ID');

  const query = `
    SELECT campaign.name, metrics.search_impression_share,
           metrics.search_rank_lost_impression_share,
           metrics.search_budget_lost_impression_share
    FROM campaign
    WHERE segments.date DURING LAST_7_DAYS
      AND campaign.status = 'ENABLED'
      AND campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING', 'PERFORMANCE_MAX')
  `.trim();

  const url = `https://googleads.googleapis.com/v17/customers/${cleanCustomerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': developerToken,
      ...(cleanManagerId ? { 'login-customer-id': cleanManagerId } : {}),
    },
    body: JSON.stringify({ query }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Google Ads Search Visibility error: ${data.error.message || JSON.stringify(data.error)}`);
  if (Array.isArray(data) && data[0]?.error) throw new Error(`Google Ads Search Visibility error: ${data[0].error.message}`);

  const results = {};
  const batches = Array.isArray(data) ? data : [data];
  for (const batch of batches) {
    for (const row of batch.results || []) {
      const name = row.campaign?.name;
      if (!name) continue;
      results[name] = {
        search_impression_share: Number(row.metrics?.searchImpressionShare || 0) * 100,
        search_rank_lost_impression_share: Number(row.metrics?.searchRankLostImpressionShare || 0) * 100,
        search_budget_lost_impression_share: Number(row.metrics?.searchBudgetLostImpressionShare || 0) * 100,
      };
    }
  }
  return results;
}

module.exports = { fetchGoogleAdsInsights, fetchSearchVisibility, getAccessTokenFromRefreshToken };
