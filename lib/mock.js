// Structure: 5 campaigns, each with 2 ad sets, each ad set with 2 ads.
// Deliberately seeded problems at each level so the insights engine has
// something real to find in demo mode, not just flat numbers:
//  - Campaign "Prospecting - Broad" -> creative fatigue (CTR down, CPA up)
//  - Its ad set "Broad - 25-45" -> a further reach-dilution problem
//  - One specific ad inside that ad set -> conversions stall despite clicks
const STRUCTURE = [
  { campaign: 'Prospecting - Broad', adsets: [
    { name: 'Broad - 25-45', ads: ['Video - UGC Testimonial', 'Static - Offer Banner'] },
    { name: 'Broad - 45-65', ads: ['Video - Founder Story', 'Carousel - Product Grid'] },
  ]},
  { campaign: 'Retargeting - Cart', adsets: [
    { name: 'Cart Abandoners 7d', ads: ['Static - Discount 10%', 'Video - Social Proof'] },
    { name: 'Cart Abandoners 30d', ads: ['Static - Free Shipping', 'Carousel - Bestsellers'] },
  ]},
  { campaign: 'Lookalike 1%', adsets: [
    { name: 'LAL 1% - Purchasers', ads: ['Video - Unboxing', 'Static - Reviews'] },
    { name: 'LAL 1% - Engagers', ads: ['Carousel - New Arrivals', 'Static - Brand Story'] },
  ]},
  { campaign: 'Brand Search', adsets: [
    { name: 'Exact Match', ads: ['Search Ad - Brand Terms'] },
    { name: 'Broad Match', ads: ['Search Ad - Category Terms'] },
  ]},
  { campaign: 'Interest - Fitness', adsets: [
    { name: 'Fitness Enthusiasts', ads: ['Video - Workout Demo', 'Static - Before After'] },
    { name: 'Gym Owners', ads: ['Video - B2B Pitch', 'Static - Bulk Pricing'] },
  ]},
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateMockMetrics(adAccountId, days = 30) {
  const rand = seededRandom(adAccountId * 7919);
  const rows = [];
  const today = new Date();
  const fatigueStartsAt = Math.floor(days * 0.4);

  STRUCTURE.forEach((camp, ci) => {
    const campIsFatigued = ci === 0; // "Prospecting - Broad"

    camp.adsets.forEach((adset, asi) => {
      // Within the fatigued campaign, one specific ad set has it worse
      // (reach diluted further) than its sibling ad set
      const adsetExtraDilution = campIsFatigued && asi === 0;

      adset.ads.forEach((adName, adi) => {
        const baseSpendPerDay = (300 + rand() * 900); // split across ads within an ad set
        const cpm = 90 + rand() * 220;
        const baseCtr = 0.012 + rand() * 0.018;
        const baseConvRate = 0.02 + rand() * 0.05;
        const avgOrderValue = 700 + rand() * 1800;

        // The specific "problem ad": clicks stay fine but conversions stall
        // (funnel/landing-page signature) — only this one ad, inside the
        // already-fatigued campaign and ad set
        const isProblemAd = campIsFatigued && adsetExtraDilution && adi === 0;

        for (let d = days - 1; d >= 0; d--) {
          const date = new Date(today);
          date.setDate(date.getDate() - d);

          let ctr = baseCtr;
          let convRate = baseConvRate;
          let impressionMultiplier = 1;
          let inFatigueWindow = false;

          if (campIsFatigued && d <= fatigueStartsAt) {
            const progress = 1 - (d / fatigueStartsAt);
            ctr = baseCtr * (1 - progress * 0.5);
            convRate = baseConvRate * (1 - progress * 0.35);
            inFatigueWindow = true;
          }
          if (adsetExtraDilution && d <= fatigueStartsAt) {
            const progress = 1 - (d / fatigueStartsAt);
            impressionMultiplier = 1 + progress * 0.6; // reach grows while CTR drops
          }
          if (isProblemAd && d <= fatigueStartsAt) {
            // clicks stay roughly normal but conversion rate collapses harder
            convRate = convRate * 0.3;
          }

          const spend = Math.round((baseSpendPerDay + (rand() - 0.5) * baseSpendPerDay * 0.3) * 100) / 100;
          const impressions = Math.round((spend / cpm * 1000) * impressionMultiplier);
          const clicks = Math.round(impressions * ctr);
          const conversions = Math.round(clicks * convRate * 10) / 10;
          const revenue = Math.round(conversions * avgOrderValue * 100) / 100;
          // Reach is always <= impressions — frequency (impressions/reach)
          // climbs when the same people keep seeing the ad, exactly what
          // happens during creative fatigue
          const frequencyFactor = inFatigueWindow ? 1.6 + rand() * 0.8 : 1.1 + rand() * 0.3;
          const reach = Math.round(impressions / frequencyFactor);
          // Engagement mirrors CTR fatigue (same audience tuning out shows
          // up in both) — video ads get real video_views, static ads don't
          const engagementRate = (0.03 + rand() * 0.05) * (inFatigueWindow ? 0.6 : 1);
          const engagement = Math.round(impressions * engagementRate);
          const isVideoAd = adName.toLowerCase().startsWith('video');
          const video_views = isVideoAd ? Math.round(impressions * (0.15 + rand() * 0.15)) : 0;
          const link_clicks = Math.round(clicks * (0.7 + rand() * 0.2)); // subset of total clicks

          rows.push({
            campaign_name: camp.campaign,
            ad_set_name: adset.name,
            ad_name: adName,
            date: date.toISOString().slice(0, 10),
            spend, impressions, reach, clicks, conversions, revenue,
            engagement, video_views, link_clicks,
            quality_ranking: isProblemAd && inFatigueWindow ? 'below_average' : 'average',
            engagement_rate_ranking: campIsFatigued && inFatigueWindow ? 'below_average' : 'average',
            conversion_rate_ranking: isProblemAd && inFatigueWindow ? 'below_average' : 'average',
          });
        }
      });
    });
  });
  return rows;
}

module.exports = { generateMockMetrics };
