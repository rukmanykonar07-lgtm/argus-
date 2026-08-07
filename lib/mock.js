const CAMPAIGNS = ['Prospecting - Broad', 'Retargeting - Cart', 'Lookalike 1%', 'Brand Search', 'Interest - Fitness'];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Deterministic per-account mock data so refreshes look consistent, not
// random noise. One campaign gets a deliberate mid-range performance shift
// (creative fatigue pattern: CTR drops, CPA climbs, spend stays flat) so
// the insights engine has a real, findable story in demo mode — not just
// flat numbers with nothing to explain.
function generateMockMetrics(adAccountId, days = 30) {
  const rand = seededRandom(adAccountId * 7919);
  const rows = [];
  const today = new Date();
  const fatigueStartsAt = Math.floor(days * 0.4); // days ago the shift begins
  const fatigueCampaignIndex = 0; // "Prospecting - Broad" is the one that dips

  CAMPAIGNS.forEach((name, ci) => {
    const baseSpendPerDay = 800 + rand() * 3200;     // ₹800–4000/day, realistic agency spend
    const cpm = 90 + rand() * 220;                    // ₹90–310 cost per 1000 impressions
    const baseCtr = 0.012 + rand() * 0.018;            // 1.2%–3% CTR
    const baseConvRate = 0.02 + rand() * 0.05;         // 2%–7% of clicks convert
    const avgOrderValue = 700 + rand() * 1800;         // ₹700–2500 AOV

    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(today);
      date.setDate(date.getDate() - d);

      let ctr = baseCtr;
      let convRate = baseConvRate;

      // Apply the fatigue event: this campaign's CTR and conversion rate
      // degrade gradually once we cross into the "fatigue window"
      if (ci === fatigueCampaignIndex && d <= fatigueStartsAt) {
        const progress = 1 - (d / fatigueStartsAt); // 0 -> 1 as it worsens
        ctr = baseCtr * (1 - progress * 0.55);
        convRate = baseConvRate * (1 - progress * 0.4);
      }

      const spend = Math.round((baseSpendPerDay + (rand() - 0.5) * baseSpendPerDay * 0.3) * 100) / 100;
      const impressions = Math.round(spend / cpm * 1000);
      const clicks = Math.round(impressions * ctr);
      const conversions = Math.round(clicks * convRate * 10) / 10;
      const revenue = Math.round(conversions * avgOrderValue * 100) / 100;

      rows.push({
        campaign_name: name,
        date: date.toISOString().slice(0, 10),
        spend, impressions, clicks, conversions, revenue,
      });
    }
  });
  return rows;
}

module.exports = { generateMockMetrics };
