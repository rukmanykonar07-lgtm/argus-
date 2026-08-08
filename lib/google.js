const fetch = require('node-fetch');

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

module.exports = { fetchGoogleAdsInsights };
