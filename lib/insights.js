// Rule-based, not ML. Compares one entity's current-period metrics against
// its own previous period and returns ONE diagnosis — the most important
// thing happening with it — always framed with honest confidence.
// Used identically at brand level, campaign level, ad set level, and ad
// level: same rules, same object shape, just fed different aggregates.

function pctChange(curr, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  if (curr === null || curr === undefined) return null;
  return ((curr - prev) / prev) * 100;
}

// curr/prev shape: { spend, impressions, clicks, conversions, revenue, ctr, cpa, roas }
function evaluateEntity(curr, prev) {
  // "Enough history" needs to be about sample size, not a currency amount.
  // The old version gated on `prev.spend < 5` — meaningless once amounts
  // are in ₹ rather than the $ it was probably tuned for (₹5 clears
  // almost anything). Clicks are what the percentage math below is
  // actually built on, so gate on that instead — currency-agnostic.
  const MIN_CLICKS = 30;
  if (!prev || prev.clicks < MIN_CLICKS) {
    return {
      severity: 'unknown', confidence: '', title: 'Not enough history yet',
      explanation: `The previous period only had ${prev ? prev.clicks : 0} clicks — under ${MIN_CLICKS} isn't enough traffic to trust a percentage comparison against. Check back once it's run a full period with more volume.`,
    };
  }

  const ctrChange = pctChange(curr.ctr, prev.ctr);
  const cpaChange = pctChange(curr.cpa, prev.cpa);
  const spendChange = pctChange(curr.spend, prev.spend);
  const convChange = pctChange(curr.conversions, prev.conversions);
  const impChange = pctChange(curr.impressions, prev.impressions);
  const revChange = pctChange(curr.revenue, prev.revenue);
  const roasChange = pctChange(curr.roas, prev.roas);

  // Anything derived from conversions (CPA, ROAS, conversion rate) is the
  // noisiest signal at low volume — 5 vs 6 conversions reads as "+20%"
  // but is just noise. Gate those specific rules separately and stricter;
  // CTR/impression-based rules (which don't touch conversions) stay open.
  const MIN_CONVERSIONS = 10;
  const conversionSampleOk = (prev.conversions || 0) >= MIN_CONVERSIONS && (curr.conversions || 0) >= MIN_CONVERSIONS;

  // Rule 1: creative fatigue — CPA up, CTR down, spend roughly flat
  if (conversionSampleOk && cpaChange !== null && cpaChange > 25 && ctrChange !== null && ctrChange < -15 && spendChange !== null && Math.abs(spendChange) < 20) {
    return {
      severity: 'concern', confidence: 'likely',
      title: 'Cost per result climbing',
      explanation: `CPA is up ${cpaChange.toFixed(0)}% while CTR dropped ${Math.abs(ctrChange).toFixed(0)}% — spend stayed roughly flat, so the audience is likely tuning the creative out. Likely cause: creative fatigue. Worth refreshing the creative or rotating in new variants.`,
    };
  }

  // Rule 2: reach diluting — impressions up a lot, CTR down a lot.
  // Doesn't touch conversions, so this stays valid even at low volume.
  if (impChange !== null && impChange > 30 && ctrChange !== null && ctrChange < -20) {
    return {
      severity: 'concern', confidence: 'possibly',
      title: 'Reach grew, engagement did not keep up',
      explanation: `Impressions rose ${impChange.toFixed(0)}% but CTR fell ${Math.abs(ctrChange).toFixed(0)}%. Possibly the audience widened into a less relevant segment. Worth checking if targeting settings changed recently.`,
    };
  }

  // Rule 3: clicks up, conversions flat — funnel/landing page issue
  if (conversionSampleOk && curr.clicks > prev.clicks * 1.2 && convChange !== null && convChange < 5) {
    return {
      severity: 'concern', confidence: 'unclear — worth checking manually',
      title: 'More clicks, conversions did not follow',
      explanation: `Clicks are up but conversions stayed roughly flat. This usually points past the ad itself — landing page load time, an offer mismatch, or a broken conversion pixel are the common causes. Not enough data here to say which for certain.`,
    };
  }

  // Rule 4: genuinely improving — CPA down, ROAS up
  if (conversionSampleOk && cpaChange !== null && cpaChange < -15 && curr.roas && prev.roas && curr.roas > prev.roas) {
    return {
      severity: 'good', confidence: 'likely',
      title: 'Efficiency improving',
      explanation: `CPA dropped ${Math.abs(cpaChange).toFixed(0)}% and ROAS improved. Likely the algorithm's delivery optimizing as it gathers more conversion data — a good sign to consider increasing budget here while it's working.`,
    };
  }

  // Rule 5: spend jumped with no efficiency change either way — flag, not
  // alarm. At low conversion volume we still flag the spend jump itself
  // (that's just currency, no derived-ratio noise) but say plainly that
  // efficiency can't be judged yet rather than implying it's "steady."
  if (spendChange !== null && spendChange > 40) {
    if (conversionSampleOk && Math.abs(cpaChange || 0) < 15) {
      return {
        severity: 'neutral', confidence: 'assume',
        title: 'Spend increased noticeably',
        explanation: `Spend is up ${spendChange.toFixed(0)}% with CPA holding roughly steady — efficiency hasn't changed, so this is most likely a deliberate budget increase rather than a problem. Flagging so it's not a surprise on the invoice.`,
      };
    }
    if (!conversionSampleOk) {
      return {
        severity: 'neutral', confidence: 'assume',
        title: 'Spend increased noticeably',
        explanation: `Spend is up ${spendChange.toFixed(0)}%. Too few conversions this period (${curr.conversions || 0}, need ${MIN_CONVERSIONS}+) to say yet whether efficiency held — worth a second look once more data comes in.`,
      };
    }
  }

  // Rule 6 (catch-all, concern): the specific patterns above are narrow —
  // this exists so nothing with a real, meaningful decline in the numbers
  // that actually matter (revenue, ROAS, CPA, conversions) can ever fall
  // through to a false "Perfect" just because it didn't match a named
  // pattern. Always cites the real numbers, never a vague warning.
  // Conversion-derived signals (roas/cpa/conversions) only count when the
  // sample is big enough to trust; revenue is raw currency so stays valid.
  const declineSignals = [];
  if (revChange !== null && revChange < -10) declineSignals.push(`revenue down ${Math.abs(revChange).toFixed(1)}%`);
  if (conversionSampleOk && roasChange !== null && roasChange < -10) declineSignals.push(`ROAS down ${Math.abs(roasChange).toFixed(1)}%`);
  if (conversionSampleOk && cpaChange !== null && cpaChange > 15) declineSignals.push(`CPA up ${cpaChange.toFixed(1)}%`);
  if (conversionSampleOk && convChange !== null && convChange < -15) declineSignals.push(`conversions down ${Math.abs(convChange).toFixed(1)}%`);
  if (declineSignals.length) {
    return {
      severity: 'concern', confidence: 'likely',
      title: 'Performance trending down',
      explanation: `${declineSignals.join(', ')} vs the previous period. This doesn't match one single clean pattern (like creative fatigue or a funnel issue specifically) — it's a general decline worth a manual look: check recent budget, targeting, or creative changes, and competitor activity in the same auction.`,
    };
  }

  // Rule 7 (catch-all, good): same logic in the positive direction
  const improveSignals = [];
  if (revChange !== null && revChange > 15) improveSignals.push(`revenue up ${revChange.toFixed(1)}%`);
  if (conversionSampleOk && roasChange !== null && roasChange > 15) improveSignals.push(`ROAS up ${roasChange.toFixed(1)}%`);
  if (conversionSampleOk && cpaChange !== null && cpaChange < -10 && !(roasChange !== null && roasChange < 0)) improveSignals.push(`CPA down ${Math.abs(cpaChange).toFixed(1)}%`);
  if (improveSignals.length) {
    return {
      severity: 'good', confidence: 'likely',
      title: 'Performance trending up',
      explanation: `${improveSignals.join(', ')} vs the previous period — genuine improvement, even if it doesn't match one specific named pattern. Worth noting what changed recently so it can be repeated.`,
    };
  }

  // Too little conversion volume to score confidently, and nothing else
  // above fired — say so explicitly instead of defaulting to "Perfect"
  // on a sample too thin to actually judge.
  if (!conversionSampleOk) {
    return {
      severity: 'unknown', confidence: '',
      title: 'Too few conversions to score',
      explanation: `${curr.conversions || 0} conversions this period (need ${MIN_CONVERSIONS}+) — cost and ROAS trends aren't reliable yet at this volume. Reach and CTR were checked separately and came back clean.`,
    };
  }

  // Only reaches here if EVERY core outcome metric (revenue, ROAS, CPA,
  // conversions) moved less than the thresholds above in both directions,
  // AND the sample was big enough to trust that read — a real "nothing
  // meaningful happened" state, not a fallback for "didn't match anything."
  return { severity: 'perfect', confidence: '', title: 'Perfect', explanation: '' };
}

// Goal-aware check — compares actual period totals against a client's own
// stated targets, not a fixed generic threshold. This is what actually
// tells you "is this good FOR THIS CLIENT" instead of just "did it move."
// Returns null when no targets are set (nothing to compare against).
function evaluateGoal(totals, goals) {
  if (!goals || (!goals.target_cpa && !goals.target_roas)) return null;
  const notes = [];
  let behind = false;
  if (goals.target_cpa && totals.cpa !== null && totals.cpa !== undefined) {
    const overBy = ((totals.cpa - goals.target_cpa) / goals.target_cpa) * 100;
    if (overBy > 10) { behind = true; notes.push(`CPA is ₹${totals.cpa.toFixed(0)} vs a ₹${goals.target_cpa} target — ${overBy.toFixed(0)}% over`); }
    else if (overBy < -10) notes.push(`CPA is ₹${totals.cpa.toFixed(0)}, beating the ₹${goals.target_cpa} target by ${Math.abs(overBy).toFixed(0)}%`);
    else notes.push(`CPA is ₹${totals.cpa.toFixed(0)}, on target (₹${goals.target_cpa})`);
  }
  if (goals.target_roas && totals.roas !== null && totals.roas !== undefined) {
    const underBy = ((goals.target_roas - totals.roas) / goals.target_roas) * 100;
    if (underBy > 10) { behind = true; notes.push(`ROAS is ${totals.roas.toFixed(2)}x vs a ${goals.target_roas}x target — ${underBy.toFixed(0)}% short`); }
    else if (underBy < -10) notes.push(`ROAS is ${totals.roas.toFixed(2)}x, beating the ${goals.target_roas}x target`);
    else notes.push(`ROAS is ${totals.roas.toFixed(2)}x, on target (${goals.target_roas}x)`);
  }
  if (!notes.length) return null;
  return {
    severity: behind ? 'concern' : 'good', confidence: 'vs stated goal',
    title: behind ? 'Behind target' : 'Tracking to target',
    explanation: notes.join('. ') + '.',
  };
}

// Structural/setup checks — distinct from evaluateEntity's trend
// comparison. These are single-period absolute-threshold checks, so they
// catch things even on a brand-new campaign with no prior period to
// compare against (exactly where the trend engine has nothing to say).
// Can return several findings — setup problems stack, unlike
// evaluateEntity's single diagnosis.
function auditEntity(curr, searchVisibility) {
  const findings = [];

  // Zero conversions is only a real signal when there was enough traffic
  // to expect at least one — spend alone doesn't establish that (a short
  // date-range view or a slow week can rack up spend with naturally zero
  // conversions without anything being broken). Clicks are the more
  // honest proxy, same principle as the MIN_CLICKS gate in evaluateEntity
  // above — consistent with how the rest of this file already reasons
  // about sample size, and range-length-agnostic since both clicks and
  // spend scale down naturally on a shorter window instead of needing a
  // separate day-count parameter threaded through.
  const MIN_CLICKS_FOR_TRACKING_CHECK = 50;
  const MIN_SPEND_FOR_TRACKING_CHECK = 500;
  if (curr.spend >= MIN_SPEND_FOR_TRACKING_CHECK && curr.clicks >= MIN_CLICKS_FOR_TRACKING_CHECK && (curr.conversions || 0) === 0) {
    findings.push({
      title: 'Zero conversions despite real spend and clicks',
      explanation: `₹${curr.spend.toFixed(0)} spent and ${curr.clicks} clicks with 0 conversions recorded. People are clicking but nothing is converting — worth checking the conversion pixel/tag is actually firing before assuming the campaign itself is the problem.`,
    });
  }

  if (curr.impressions >= 500 && curr.clicks === 0) {
    findings.push({
      title: 'Zero clicks despite impressions',
      explanation: `${curr.impressions.toFixed(0)} impressions with 0 clicks. Usually means a disapproved or broken creative rather than just low interest — worth checking the ad actually rendered.`,
    });
  }

  if (curr.frequency && curr.frequency > 5) {
    findings.push({
      title: `Audience oversaturated (frequency ${curr.frequency.toFixed(1)})`,
      explanation: `The same people are seeing this ${curr.frequency.toFixed(1)}x on average. Expand the audience or refresh creative — this is a setup/targeting ceiling, not something that fixes itself.`,
    });
  }

  if (searchVisibility && searchVisibility.search_budget_lost_impression_share > 30) {
    findings.push({
      title: `Losing ${searchVisibility.search_budget_lost_impression_share.toFixed(0)}% impression share to budget`,
      explanation: `Google says this campaign could be showing up more often with more budget. Worth flagging if this client wants more volume.`,
    });
  }

  return findings;
}

// Rule evaluation is deliberately dumb — one metric, one comparison, one
// threshold. No AND/OR condition builder, no multi-metric scoring. Build
// that if simple threshold rules prove insufficient, not before.
function evaluateRule(totals, rule) {
  const val = totals[rule.metric];
  if (val === null || val === undefined) return false;
  if (rule.operator === '>') return val > rule.value;
  if (rule.operator === '<') return val < rule.value;
  return false;
}

module.exports = { evaluateEntity, evaluateGoal, auditEntity, evaluateRule, pctChange };
