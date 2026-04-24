'use strict';

const { claimDuePosts, markPostSent } = require('./db');
const { randomUUID } = require('crypto');
const db = require('./db');
const notion = require('./notion');

async function listAllChannelMembers(client, channel) {
  const members = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const resp = await client.conversations.members({
      channel,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (!resp?.ok) throw new Error(resp?.error || 'Failed to list channel members');
    if (Array.isArray(resp.members)) members.push(...resp.members);
    cursor = resp.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return [...new Set(members)].filter((id) => id && id !== 'USLACKBOT');
}

async function resolveRecipientsAtSendTime(app, payload) {
  // Backwards compatible: older scheduled payloads may have `recipients`
  if (Array.isArray(payload.recipients) && payload.recipients.length) {
    return [...new Set(payload.recipients)].filter(Boolean);
  }

  const includeChannelMembers = Boolean(payload.includeChannelMembers);
  const usergroupIds = Array.isArray(payload.usergroupIds) ? payload.usergroupIds : [];
  const individualUsers = Array.isArray(payload.individualUsers) ? payload.individualUsers : [];
  const channels = Array.isArray(payload.channels) ? payload.channels : [];

  let userIds = [];

  for (const ugId of usergroupIds) {
    try {
      const membersRes = await app.client.usergroups.users.list({ usergroup: ugId });
      userIds = userIds.concat(membersRes.users || []);
    } catch (err) {
      console.error(`[scheduler] usergroup resolve failed for ${ugId}:`, err?.data?.error || err.message);
    }
  }

  if (includeChannelMembers) {
    for (const channelId of channels) {
      try {
        const members = await listAllChannelMembers(app.client, channelId);
        userIds = userIds.concat(members);
      } catch (err) {
        console.error(`[scheduler] channel member resolve failed for ${channelId}:`, err?.data?.error || err.message);
      }
    }
  }

  return [...new Set([...userIds, ...individualUsers])].filter(Boolean);
}

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

function buildAnnouncementBlocks({ title, message, senderId, announcementId, groupName, linkUrl = null }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `📣 ${title || ''}`.trim(), emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent by <@${senderId}>` }] },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: message || '' } },
    ...(linkUrl
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `🔗 <${linkUrl}|View more>` } }]
      : []),
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        linkUrl
          ? {
              type: 'button',
              text: { type: 'plain_text', text: '📖 Open to Read', emoji: true },
              action_id: 'mark_as_read',
              value: announcementId,
              url: linkUrl,
              style: 'primary',
            }
          : {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Mark as Read', emoji: true },
              action_id: 'mark_as_read',
              value: announcementId,
              style: 'primary',
              confirm: {
                title: { type: 'plain_text', text: "Confirm you've read this" },
                text: { type: 'plain_text', text: 'This will notify the sender that you have read the announcement.' },
                confirm: { type: 'plain_text', text: "Yes, I've read it" },
                deny: { type: 'plain_text', text: 'Cancel' },
              },
            },
      ],
    },
  ];
}

async function sendScheduledAnnounce(app, payload) {
  const recipients = await resolveRecipientsAtSendTime(app, payload);
  const fallback = payload.title || payload.message || 'New announcement';
  const announcementId = payload.announcementId || randomUUID();
  const senderId = payload.created_by || payload.senderId || payload.sender_id || 'unknown';

  // Create DB record for tracking (best-effort)
  try {
    await db.createAnnouncement({
      id: announcementId,
      sender_id: senderId,
      sender_name: payload.senderName || null,
      message: payload.message,
      group_name: payload.groupName || 'Scheduled',
      target_type: 'scheduled',
      target_id: null,
    });
  } catch (err) {
    console.error('[scheduler] createAnnouncement failed:', err?.data?.error || err.message);
  }

  const recipientRows = [];
  for (const userId of recipients) {
    try {
      // Store recipient row for tracking (best-effort)
      recipientRows.push({ user_id: userId, user_name: userId });
      await app.client.chat.postMessage({
        channel: userId,
        blocks: buildAnnouncementBlocks({
          title: payload.title,
          message: payload.message,
          senderId,
          announcementId,
          groupName: payload.groupName || 'Scheduled',
          linkUrl: payload.link || null,
        }),
        text: fallback
      });
    } catch (err) {
      console.error(`[scheduler] announce DM failed for ${userId}:`, err?.data?.error || err.message);
    }
  }

  try {
    await db.addRecipients(announcementId, recipientRows);
    await db.updateRecipientCount(announcementId, recipientRows.length);
  } catch (err) {
    console.error('[scheduler] addRecipients/updateRecipientCount failed:', err?.data?.error || err.message);
  }

  // Post visibly in channels (if any), regardless of includeChannelMembers
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  for (const channelId of channels) {
    try {
      try { await app.client.conversations.join({ channel: channelId }); } catch {}
      await app.client.chat.postMessage({
        channel: channelId,
        text: `📣 Announcement from <@${senderId}>: ${payload.message}`,
        blocks: buildAnnouncementBlocks({
          title: payload.title,
          message: payload.message,
          senderId,
          announcementId,
          groupName: payload.groupName || 'Scheduled',
          linkUrl: payload.link || null,
        }),
      });
    } catch (err) {
      console.error(`[scheduler] announce channel post failed for ${channelId}:`, err?.data?.error || err.message);
    }
  }

  // Notion sync (best-effort)
  try {
    const sentAt = new Date().toISOString();
    const pageId = await notion.createAnnouncementPage({
      announcementId,
      title: payload.title,
      message: payload.message,
      senderName: payload.senderName || 'Scheduled',
      groupName: payload.groupName || 'Scheduled',
      totalRecipients: recipients.length,
      linkUrl: payload.link || null,
      sentAt,
    });
    if (pageId && recipientRows.length) {
      await notion.createRecipientRows({ announcementPageId: pageId, recipients: recipientRows, sentAt });
    }
  } catch (err) {
    console.warn('[scheduler] Notion announce sync failed:', err.message);
  }
}

// ─── Pulse sender ──────────────────────────────────────────────────────────────
// NOTE: Must match the action IDs/value formats handled in radarping/index.js.
function buildPulseProgressBar(current, total) {
  if (!total) return '';
  const filled = Math.min(current, total);
  const empty = total - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function buildPulseDMBlocks(campaign, questionIndex) {
  const questions = campaign.questions || [];
  const question = questions[questionIndex];
  const total = questions.length;
  const progressBar = buildPulseProgressBar(questionIndex, total);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${campaign.title}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${progressBar}  Question ${questionIndex + 1} of ${total}` }] },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*${question?.text || ''}*` } },
  ];

  if (question?.response_type === 'scale_10') {
    if (question.low_label || question.high_label) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${question.low_label ? `_${question.low_label}_ ←` : ''} ${question.high_label ? `→ _${question.high_label}_` : ''}`.trim() }],
      });
    }
    blocks.push({ type: 'actions', elements: [1, 2, 3, 4, 5].map((n) => ({ type: 'button', text: { type: 'plain_text', text: String(n), emoji: true }, action_id: `pulse_scale_${n}`, value: `${campaign.id}:${questionIndex}:${n}` })) });
    blocks.push({ type: 'actions', elements: [6, 7, 8, 9, 10].map((n) => ({ type: 'button', text: { type: 'plain_text', text: String(n), emoji: true }, action_id: `pulse_scale_${n}`, value: `${campaign.id}:${questionIndex}:${n}` })) });
  } else if (question?.response_type === 'scale_5') {
    if (question.low_label || question.high_label) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${question.low_label ? `_${question.low_label}_ ←` : ''} ${question.high_label ? `→ _${question.high_label}_` : ''}`.trim() }],
      });
    }
    blocks.push({ type: 'actions', elements: [1, 2, 3, 4, 5].map((n) => ({ type: 'button', text: { type: 'plain_text', text: String(n), emoji: true }, action_id: `pulse_scale_${n}`, value: `${campaign.id}:${questionIndex}:${n}` })) });
  } else if (question?.response_type === 'multi_select') {
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
    blocks.push({
      type: 'input',
      block_id: blockId,
      optional: true,
      dispatch_action: false,
      element: {
        type: 'plain_text_input',
        action_id: 'pulse_text_value',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Type your answer here...' },
      },
      label: { type: 'plain_text', text: 'Your answer', emoji: true },
    });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Submit →', emoji: true }, action_id: 'pulse_text_submit', value: `${campaign.id}:${questionIndex}`, style: 'primary' },
      ],
    });
  }

  return blocks;
}

async function sendScheduledPulse(app, payload) {
  const campaignId = randomUUID();
  const senderId = payload.created_by || payload.senderId || payload.sender_id || 'unknown';
  const recipients = await resolveRecipientsAtSendTime(app, payload);

  // Persist campaign so interactive responses can be tracked
  try {
    await db.createPulseCampaign({
      id: campaignId,
      title: payload.title,
      sender_slack_id: senderId,
      target_raw: 'scheduled',
      target_type: 'scheduled',
      resolved_users: recipients,
      questions: payload.questions,
    });
  } catch (err) {
    console.error('[scheduler] createPulseCampaign failed:', err?.data?.error || err.message);
  }

  const campaign = { id: campaignId, title: payload.title, questions: payload.questions };
  const blocks = buildPulseDMBlocks(campaign, 0);
  const fallback = `New pulse: ${payload.title}`;

  for (const userId of recipients) {
    try {
      const responseId = randomUUID();
      await db.createPulseResponse({ id: responseId, campaign_id: campaignId, slack_user_id: userId, slack_display_name: userId });
      const dmResult = await app.client.chat.postMessage({ channel: userId, blocks, text: fallback });
      if (dmResult?.ts) {
        await db.createPulseState({ id: randomUUID(), campaign_id: campaignId, slack_user_id: userId, dm_ts: dmResult.ts, dm_channel: dmResult.channel });
      }
    } catch (err) {
      console.error(`[scheduler] pulse DM failed for ${userId}:`, err?.data?.error || err.message);
    }
  }

  // Post visibly in channels (if any), regardless of includeChannelMembers
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  for (const channelId of channels) {
    try {
      try { await app.client.conversations.join({ channel: channelId }); } catch {}
      await app.client.chat.postMessage({
        channel: channelId,
        text: `📊 ${payload.title} — pulse check-in from <@${senderId}>`,
        blocks,
      });
    } catch (err) {
      console.error(`[scheduler] pulse channel post failed for ${channelId}:`, err?.data?.error || err.message);
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
