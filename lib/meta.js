const fetch = require('node-fetch');

// Pulls daily spend/impressions/clicks/conversions at AD level (not just
// campaign level) — one call returns campaign_name + adset_name + ad_name
// together, so the full hierarchy comes from a single query per chunk
// rather than three separate calls. Chunked into 7-day windows (avoids
// the timeout issue documented for wide date ranges in one call).
async function fetchMetaInsights(adAccountId, accessToken, sinceDate, untilDate) {
  const chunks = getWeekChunks(sinceDate, untilDate);
  const allRows = [];

  for (const chunk of chunks) {
    const fields = 'campaign_name,adset_name,ad_name,spend,impressions,reach,clicks,actions,action_values,' +
      'quality_ranking,engagement_rate_ranking,conversion_rate_ranking,date_start';
    const url = `https://graph.facebook.com/v19.0/${adAccountId}/insights` +
      `?level=ad&fields=${fields}` +
      `&time_range={"since":"${chunk.since}","until":"${chunk.until}"}` +
      `&time_increment=1&limit=500&access_token=${accessToken}`;

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
        ad_set_name: row.adset_name,
        ad_name: row.ad_name,
        date: row.date_start,
        spend: Number(row.spend || 0),
        impressions: Number(row.impressions || 0),
        reach: Number(row.reach || 0),
        clicks: Number(row.clicks || 0),
        conversions,
        revenue,
        // Meta's own diagnostic rankings vs other advertisers competing for
        // the same audience — this is Meta telling you WHY an ad struggles,
        // not us inferring it. Only present at ad level, same value repeats
        // across days for a given ad, so we just keep the latest.
        quality_ranking: row.quality_ranking || null,
        engagement_rate_ranking: row.engagement_rate_ranking || null,
        conversion_rate_ranking: row.conversion_rate_ranking || null,
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
