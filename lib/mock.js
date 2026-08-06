const CAMPAIGNS = ['Prospecting - Broad', 'Retargeting - Cart', 'Lookalike 1%', 'Brand Search', 'Interest - Fitness'];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Deterministic per-account mock data so refreshes look consistent, not random noise
function generateMockMetrics(adAccountId, days = 30) {
  const rand = seededRandom(adAccountId * 7919);
  const rows = [];
  const today = new Date();

  CAMPAIGNS.forEach((name, ci) => {
    const baseSpend = 30 + rand() * 120;
    const baseCtr = 0.008 + rand() * 0.02;
    const baseConvRate = 0.01 + rand() * 0.04;

    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(today);
      date.setDate(date.getDate() - d);
      const spend = Math.round((baseSpend + (rand() - 0.5) * 20) * 100) / 100;
      const impressions = Math.round(spend / (0.5 + rand() * 2) * 1000);
      const clicks = Math.round(impressions * baseCtr);
      const conversions = Math.round(clicks * baseConvRate * 10) / 10;
      rows.push({
        campaign_name: name,
        date: date.toISOString().slice(0, 10),
        spend,
        impressions,
        clicks,
        conversions,
      });
    }
  });
  return rows;
}

module.exports = { generateMockMetrics };
