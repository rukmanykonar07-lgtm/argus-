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
    // access_token URL-encoded — tokens can contain characters (like &)
    // that would otherwise silently corrupt the query string.
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(adAccountId)}/insights` +
      `?level=ad&fields=${fields}` +
      `&time_range={"since":"${chunk.since}","until":"${chunk.until}"}` +
      `&time_increment=1&limit=500&access_token=${encodeURIComponent(accessToken)}`;

    let data;
    try {
      const res = await fetch(url);
      data = await res.json();
    } catch (err) {
      // node-fetch/JSON errors embed the failing URL (which contains the
      // access_token) in err.message — never let that reach a log file.
      throw new Error(`Meta Insights request failed: ${err.name === 'FetchError' ? 'network error' : 'invalid response'}`);
    }
    if (data.error) throw new Error(`Meta Insights error: ${data.error.message}`);

    for (const row of data.data || []) {
      const conversions = (row.actions || [])
        .filter(a => a.action_type === 'offsite_conversion' || a.action_type === 'lead' || a.action_type === 'purchase')
        .reduce((sum, a) => sum + Number(a.value || 0), 0);
      const revenue = (row.action_values || [])
        .filter(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase')
        .reduce((sum, a) => sum + Number(a.value || 0), 0);
      // Engagement metrics — already sitting in the same `actions` array
      // we're pulling for conversions, zero extra API cost. post_engagement
      // is Meta's own rollup (likes + comments + shares + link clicks +
      // photo views etc), video_view and link_click are their own entries.
      const findAction = type => (row.actions || []).find(a => a.action_type === type);
      const engagement = Number(findAction('post_engagement')?.value || 0);
      const videoViews = Number(findAction('video_view')?.value || 0);
      const linkClicks = Number(findAction('link_click')?.value || 0);
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
        engagement,
        video_views: videoViews,
        link_clicks: linkClicks,
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
