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
  if (!prev || prev.spend < 5) {
    return { severity: 'unknown', confidence: '', title: 'Not enough history yet', explanation: 'This is new or too small in the previous period to compare against — check back after it has run a full period.' };
  }

  const ctrChange = pctChange(curr.ctr, prev.ctr);
  const cpaChange = pctChange(curr.cpa, prev.cpa);
  const spendChange = pctChange(curr.spend, prev.spend);
  const convChange = pctChange(curr.conversions, prev.conversions);
  const impChange = pctChange(curr.impressions, prev.impressions);
  const revChange = pctChange(curr.revenue, prev.revenue);
  const roasChange = pctChange(curr.roas, prev.roas);

  // Rule 1: creative fatigue — CPA up, CTR down, spend roughly flat
  if (cpaChange !== null && cpaChange > 25 && ctrChange !== null && ctrChange < -15 && spendChange !== null && Math.abs(spendChange) < 20) {
    return {
      severity: 'concern', confidence: 'likely',
      title: 'Cost per result climbing',
      explanation: `CPA is up ${cpaChange.toFixed(0)}% while CTR dropped ${Math.abs(ctrChange).toFixed(0)}% — spend stayed roughly flat, so the audience is likely tuning the creative out. Likely cause: creative fatigue. Worth refreshing the creative or rotating in new variants.`,
    };
  }

  // Rule 2: reach diluting — impressions up a lot, CTR down a lot
  if (impChange !== null && impChange > 30 && ctrChange !== null && ctrChange < -20) {
    return {
      severity: 'concern', confidence: 'possibly',
      title: 'Reach grew, engagement did not keep up',
      explanation: `Impressions rose ${impChange.toFixed(0)}% but CTR fell ${Math.abs(ctrChange).toFixed(0)}%. Possibly the audience widened into a less relevant segment. Worth checking if targeting settings changed recently.`,
    };
  }

  // Rule 3: clicks up, conversions flat — funnel/landing page issue
  if (curr.clicks > prev.clicks * 1.2 && convChange !== null && convChange < 5) {
    return {
      severity: 'concern', confidence: 'unclear — worth checking manually',
      title: 'More clicks, conversions did not follow',
      explanation: `Clicks are up but conversions stayed roughly flat. This usually points past the ad itself — landing page load time, an offer mismatch, or a broken conversion pixel are the common causes. Not enough data here to say which for certain.`,
    };
  }

  // Rule 4: genuinely improving — CPA down, ROAS up
  if (cpaChange !== null && cpaChange < -15 && curr.roas && prev.roas && curr.roas > prev.roas) {
    return {
      severity: 'good', confidence: 'likely',
      title: 'Efficiency improving',
      explanation: `CPA dropped ${Math.abs(cpaChange).toFixed(0)}% and ROAS improved. Likely the algorithm's delivery optimizing as it gathers more conversion data — a good sign to consider increasing budget here while it's working.`,
    };
  }

  // Rule 5: spend jumped with no efficiency change either way — flag, not alarm
  if (spendChange !== null && spendChange > 40 && Math.abs(cpaChange || 0) < 15) {
    return {
      severity: 'neutral', confidence: 'assume',
      title: 'Spend increased noticeably',
      explanation: `Spend is up ${spendChange.toFixed(0)}% with CPA holding roughly steady — efficiency hasn't changed, so this is most likely a deliberate budget increase rather than a problem. Flagging so it's not a surprise on the invoice.`,
    };
  }

  // Rule 6 (catch-all, concern): the specific patterns above are narrow —
  // this exists so nothing with a real, meaningful decline in the numbers
  // that actually matter (revenue, ROAS, CPA, conversions) can ever fall
  // through to a false "Perfect" just because it didn't match a named
  // pattern. Always cites the real numbers, never a vague warning.
  const declineSignals = [];
  if (revChange !== null && revChange < -10) declineSignals.push(`revenue down ${Math.abs(revChange).toFixed(1)}%`);
  if (roasChange !== null && roasChange < -10) declineSignals.push(`ROAS down ${Math.abs(roasChange).toFixed(1)}%`);
  if (cpaChange !== null && cpaChange > 15) declineSignals.push(`CPA up ${cpaChange.toFixed(1)}%`);
  if (convChange !== null && convChange < -15) declineSignals.push(`conversions down ${Math.abs(convChange).toFixed(1)}%`);
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
  if (roasChange !== null && roasChange > 15) improveSignals.push(`ROAS up ${roasChange.toFixed(1)}%`);
  if (cpaChange !== null && cpaChange < -10 && !(roasChange !== null && roasChange < 0)) improveSignals.push(`CPA down ${Math.abs(cpaChange).toFixed(1)}%`);
  if (improveSignals.length) {
    return {
      severity: 'good', confidence: 'likely',
      title: 'Performance trending up',
      explanation: `${improveSignals.join(', ')} vs the previous period — genuine improvement, even if it doesn't match one specific named pattern. Worth noting what changed recently so it can be repeated.`,
    };
  }

  // Only reaches here if EVERY core outcome metric (revenue, ROAS, CPA,
  // conversions) moved less than the thresholds above in both directions —
  // this is now a real "nothing meaningful happened" state, not a fallback
  // for "didn't match anything I checked for."
  return { severity: 'perfect', confidence: '', title: 'Perfect', explanation: '' };
}

module.exports = { evaluateEntity, pctChange };
