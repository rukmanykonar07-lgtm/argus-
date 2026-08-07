const fetch = require('node-fetch');

// Pulls daily spend/impressions/clicks/conversions per campaign for one
// Meta ad account, chunked into 7-day windows (avoids the timeout issue
// documented for wide date ranges + many breakdowns in one call).
async function fetchMetaInsights(adAccountId, accessToken, sinceDate, untilDate) {
  const chunks = getWeekChunks(sinceDate, untilDate);
  const allRows = [];

  for (const chunk of chunks) {
    const fields = 'campaign_name,spend,impressions,clicks,actions,action_values,date_start';
    const url = `https://graph.facebook.com/v19.0/${adAccountId}/insights` +
      `?level=campaign&fields=${fields}` +
      `&time_range={"since":"${chunk.since}","until":"${chunk.until}"}` +
      `&time_increment=1&limit=200&access_token=${accessToken}`;

    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(`Meta Insights error: ${data.error.message}`);

    for (const row of data.data || []) {
      const conversions = (row.actions || [])
        .filter(a => a.action_type === 'offsite_conversion' || a.action_type === 'lead' || a.action_type === 'purchase')
        .reduce((sum, a) => sum + Number(a.value || 0), 0);
      const revenue = (row.action_values || [])
        .filter(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase')
        .reduce((sum, a) => sum + Number(a.value || 0), 0);
      allRows.push({
        campaign_name: row.campaign_name,
        date: row.date_start,
        spend: Number(row.spend || 0),
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        conversions,
        revenue,
      });
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

module.exports = { fetchMetaInsights };
