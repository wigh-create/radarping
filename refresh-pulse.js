/**
 * refresh-pulse.js — one-off script to re-render open pulse DMs for a
 * specific campaign, using the latest buildPulseDMBlocks layout
 * (section-per-choice multi_select so long answers wrap).
 *
 * Usage:
 *   railway run node refresh-pulse.js "ENT pipeline stages"
 *
 * Picks the most recent pulse_campaigns row matching title ILIKE,
 * then chat.update's every pulse_state row that has dm_ts + dm_channel.
 */
require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const { Pool } = require('pg');

const titleQuery = process.argv[2];
if (!titleQuery) {
  console.error('Usage: node refresh-pulse.js "<title substring>"');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

function buildPulseProgressBar(current, total) {
  if (total === 0) return '';
  const filled = Math.min(current, total);
  const empty = total - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function buildPulseDMBlocks(campaign, questionIndex) {
  const questions = campaign.questions;
  const question = questions[questionIndex];
  const total = questions.length;
  const progressBar = buildPulseProgressBar(questionIndex, total);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${campaign.title}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${progressBar}  Question ${questionIndex + 1} of ${total}` }] },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*${question.text}*` } },
  ];
  if (question.response_type === 'scale_10') {
    if (question.low_label || question.high_label) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${question.low_label ? `_${question.low_label}_ ←` : ''} ${question.high_label ? `→ _${question.high_label}_` : ''}`.trim() }] });
    }
    blocks.push({ type: 'actions', elements: [1,2,3,4,5].map(n => ({ type: 'button', text: { type: 'plain_text', text: String(n), emoji: true }, action_id: `pulse_scale_${n}`, value: `${campaign.id}:${questionIndex}:${n}` })) });
    blocks.push({ type: 'actions', elements: [6,7,8,9,10].map(n => ({ type: 'button', text: { type: 'plain_text', text: String(n), emoji: true }, action_id: `pulse_scale_${n}`, value: `${campaign.id}:${questionIndex}:${n}` })) });
  } else if (question.response_type === 'scale_5') {
    if (question.low_label || question.high_label) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${question.low_label ? `_${question.low_label}_ ←` : ''} ${question.high_label ? `→ _${question.high_label}_` : ''}`.trim() }] });
    }
    blocks.push({ type: 'actions', elements: [1,2,3,4,5].map(n => ({ type: 'button', text: { type: 'plain_text', text: String(n), emoji: true }, action_id: `pulse_scale_${n}`, value: `${campaign.id}:${questionIndex}:${n}` })) });
  } else if (question.response_type === 'multi_select') {
    const choices = question.choices || [];
    choices.forEach((choice, idx) => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${idx + 1}.* ${choice}` },
        accessory: { type: 'button', text: { type: 'plain_text', text: 'Select', emoji: true }, action_id: `pulse_multiselect_${idx}`, value: `${campaign.id}:${questionIndex}:${idx}` },
      });
    });
    if (question.allow_free_text) {
      const blockId = `pulse_text_input_${questionIndex}`;
      blocks.push({ type: 'input', block_id: blockId, optional: true, dispatch_action: false, element: { type: 'plain_text_input', action_id: 'pulse_text_value', multiline: false, placeholder: { type: 'plain_text', text: 'Or type your own answer...' } }, label: { type: 'plain_text', text: 'Free text (optional)', emoji: true } });
      blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Submit text →', emoji: true }, action_id: 'pulse_text_submit', value: `${campaign.id}:${questionIndex}`, style: 'primary' }] });
    }
  } else {
    const blockId = `pulse_text_input_${questionIndex}`;
    blocks.push({ type: 'input', block_id: blockId, optional: true, dispatch_action: false, element: { type: 'plain_text_input', action_id: 'pulse_text_value', multiline: true, placeholder: { type: 'plain_text', text: 'Type your answer here...' } }, label: { type: 'plain_text', text: 'Your answer', emoji: true } });
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Submit →', emoji: true }, action_id: 'pulse_text_submit', value: `${campaign.id}:${questionIndex}`, style: 'primary' }] });
  }
  return blocks;
}

(async () => {
  const { rows: campaigns } = await pool.query(
    `SELECT * FROM pulse_campaigns WHERE title ILIKE $1 ORDER BY created_at DESC LIMIT 5`,
    [`%${titleQuery}%`]
  );
  if (campaigns.length === 0) {
    console.error(`No campaign found matching "${titleQuery}"`);
    process.exit(1);
  }
  const campaign = { ...campaigns[0], questions: JSON.parse(campaigns[0].questions) };
  console.log(`Using campaign: "${campaign.title}" (${campaign.id})`);
  if (campaigns.length > 1) {
    console.log(`(${campaigns.length - 1} older matches ignored)`);
  }

  const { rows: states } = await pool.query(
    `SELECT * FROM pulse_state WHERE campaign_id = $1`,
    [campaign.id]
  );
  console.log(`Found ${states.length} open pulse DM(s) to refresh.`);

  let ok = 0, fail = 0;
  for (const st of states) {
    if (!st.dm_channel || !st.dm_ts) {
      console.warn(`  ⚠️ ${st.slack_user_id} — missing dm_channel/dm_ts, skipping`);
      continue;
    }
    try {
      const blocks = buildPulseDMBlocks(campaign, st.current_question_index);
      await client.chat.update({
        channel: st.dm_channel,
        ts: st.dm_ts,
        text: `📊 ${campaign.title}`,
        blocks,
      });
      console.log(`  ✅ ${st.slack_user_id} — Q${st.current_question_index + 1}`);
      ok++;
    } catch (err) {
      console.warn(`  ❌ ${st.slack_user_id} — ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} refreshed, ${fail} failed, ${states.length - ok - fail} skipped.`);
  await pool.end();
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
