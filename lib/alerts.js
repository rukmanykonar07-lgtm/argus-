// Slack-format incoming webhook. Works for Slack as-is; Discord accepts
// the same {text: ...} shape too, so one function covers both without
// branching. Email skipped — no SMTP lib in this project and a webhook
// covers "get pinged" without adding a dependency. Add nodemailer if
// email specifically becomes a real ask.
const fetch = require('node-fetch');

async function sendAlert(webhookUrl, client, summary) {
  const lines = [`*${client.name}* needs a look:`];
  if (summary.brandInsight?.severity === 'concern') lines.push(`• ${summary.brandInsight.title} — ${summary.brandInsight.explanation}`);
  if (summary.goalInsight?.severity === 'concern') lines.push(`• ${summary.goalInsight.title} — ${summary.goalInsight.explanation}`);
  if (summary.pacing && summary.pacing.status !== 'on-track') lines.push(`• Budget pacing: ${summary.pacing.status} (${summary.pacing.pctOfBudgetUsed.toFixed(0)}% of budget used, ${summary.pacing.pctOfMonthElapsed.toFixed(0)}% of month elapsed)`);
<<<<<<< HEAD
  // Rules the agency set up specifically because they cared about them —
  // arguably the most worth pinging about of anything here, and this was
  // missing entirely until this pass: the rules engine was built after
  // this file and never wired in, so a triggered rule silently never
  // reached the webhook despite the whole feature's point being "don't
  // make me open the dashboard to find out."
  for (const action of (summary.recommendedActions || [])) {
    lines.push(`• Rule triggered: ${action.action} — ${action.message}`);
  }
=======
>>>>>>> 926a509436c406c7f5897549a9106176ab4c43df
  if (lines.length === 1) return; // nothing concerning — don't send a "you're fine" ping

  const res = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  });
  if (!res.ok) throw new Error(`webhook POST failed: ${res.status}`);
}

module.exports = { sendAlert };
