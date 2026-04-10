'use strict';

const { claimDuePosts, markPostSent } = require('./db');

// ─── Announce sender ───────────────────────────────────────────────────────────

function buildAnnounceDmBlocks({ title, message, link }) {
  const blocks = [];

  if (title) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true }
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: message || '' }
  });

  if (link) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🔗 <${link}|View more>` }
    });
  }

  return blocks;
}

async function sendScheduledAnnounce(app, payload) {
  const blocks = buildAnnounceDmBlocks(payload);
  const fallback = payload.title || payload.message || 'New announcement';

  for (const userId of (payload.recipients || [])) {
    try {
      await app.client.chat.postMessage({
        channel: userId,
        blocks,
        text: fallback
      });
    } catch (err) {
      console.error(`[scheduler] announce DM failed for ${userId}:`, err?.data?.error || err.message);
    }
  }
}

// ─── Pulse sender ──────────────────────────────────────────────────────────────
// NOTE: This mirrors the DM logic in your pulse_modal_submit handler.
// If your existing pulse DMs look different, update buildPulseDmBlocks() to match.

function buildPulseDmBlocks({ title, questions, campaignId }) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title || 'Pulse Check', emoji: true }
    }
  ];

  (questions || []).forEach((q, i) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${i + 1}. ${q}*` }
    });
  });

  blocks.push({
    type: 'actions',
    block_id: `pulse_respond_${campaignId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Respond', emoji: true },
        style: 'primary',
        action_id: 'pulse_respond_button',
        value: String(campaignId)
      }
    ]
  });

  return blocks;
}

async function sendScheduledPulse(app, payload) {
  const { createPulseCampaign, addPulseRecipient } = require('./db');

  // Create the campaign at send-time so the campaign ID is fresh
  const campaignId = await createPulseCampaign({
    title: payload.title,
    created_by: payload.created_by,
    questions: payload.questions
  });

  const blocks = buildPulseDmBlocks({ ...payload, campaignId });
  const fallback = `New pulse: ${payload.title}`;

  for (const userId of (payload.recipients || [])) {
    try {
      await addPulseRecipient({ campaign_id: campaignId, user_id: userId });
      await app.client.chat.postMessage({
        channel: userId,
        blocks,
        text: fallback
      });
    } catch (err) {
      console.error(`[scheduler] pulse DM failed for ${userId}:`, err?.data?.error || err.message);
    }
  }
}

// ─── Worker ────────────────────────────────────────────────────────────────────

async function processScheduledPosts(app) {
  const posts = await claimDuePosts();
  if (!posts.length) return;

  console.log(`[scheduler] Processing ${posts.length} post(s)`);

  for (const post of posts) {
    try {
      if (post.type === 'announce') {
        await sendScheduledAnnounce(app, post.payload);
      } else if (post.type === 'pulse') {
        await sendScheduledPulse(app, post.payload);
      } else {
        console.warn(`[scheduler] Unknown type: ${post.type}`);
      }
      await markPostSent({ id: post.id });
      console.log(`[scheduler] ✓ Sent post ${post.id} (${post.type})`);
    } catch (err) {
      console.error(`[scheduler] ✗ Failed post ${post.id}:`, err.message);
      // Status stays 'claimed' — won't retry automatically, prevents double-send
    }
  }
}

function startScheduleWorker(app) {
  console.log('[scheduler] Worker started — polling every 60s');
  // Catch any posts that fired while the app was restarting
  processScheduledPosts(app).catch(console.error);
  setInterval(() => processScheduledPosts(app).catch(console.error), 60_000);
}

module.exports = { startScheduleWorker };
