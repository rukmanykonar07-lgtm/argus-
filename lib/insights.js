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

  // Nothing notable found — this is the "everything's fine" case
  return { severity: 'perfect', confidence: '', title: 'Perfect', explanation: '' };
}

module.exports = { evaluateEntity, pctChange };
