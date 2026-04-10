/**
 * Radar Ping — Tracked Slack Broadcasts with Read Receipts & Pulse Check-ins
 *
 * Commands:
 *   /announce        - Send a tracked announcement
 *   /radarping       - Alias for /announce
 *   /announce-status - Check read receipts for your announcements
 *   /radarpulse      - Send a pulse quiz / check-in
 */
require('dotenv').config();
const { App } = require('@slack/bolt');
const { randomUUID } = require('crypto');
const db = require('./db');
const { createScheduledPost } = require('./db');
const { startScheduleWorker } = require('./schedules');
const notion = require('./notion');
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: process.env.SLACK_APP_TOKEN ? true : false,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3456,
});
// ============================================================
//  Shared: search Slack user groups (for multi_external_select)
//  Only returns @-handle groups — no channels. Channels have
//  their own dedicated multi_conversations_select picker.
// ============================================================
async function searchUserGroupOptions(client, query, logger) {
  const q = (query || '').toLowerCase().trim();
  const results = [];
  try {
    const ugRes = await client.usergroups.list({ include_disabled: false });
    for (const ug of (ugRes.usergroups || [])) {
      const label = `${ug.name} (${ug.handle})`;
      if (!q || label.toLowerCase().includes(q) || ug.handle.toLowerCase().includes(q)) {
        results.push({
          text: { type: 'plain_text', text: label, emoji: true },
          value: `slack_ug:${ug.id}:${ug.name}`,
        });
      }
    }
  } catch (e) {
    logger.warn('searchUserGroupOptions: Could not fetch usergroups:', e.message);
  }
  return results.slice(0, 100);
}
// ============================================================
//  app.options handlers — Slack calls these when a user types
//  in a multi_external_select dropdown.
// ============================================================
app.options('audience_select', async ({ ack, options, client, logger }) => {
  const results = await searchUserGroupOptions(client, options.value, logger);
  await ack({ options: results });
});
app.options('pulse_audience_select', async ({ ack, options, client, logger }) => {
  const results = await searchUserGroupOptions(client, options.value, logger);
  await ack({ options: results });
});
// ============================================================
//  Shared helper: open the announce modal
//  Field order: Title → Message → Groups → Channels → Individuals → Link → Schedule
//  - Groups = external search (user groups only)
//  - Channels = multi_conversations_select (posts visibly + DMs members)
//  - No separate "Also post in channel" — selecting a channel does both
// ============================================================
async function openAnnounceModal({ client, triggerId, prefillMessage = '', logger }) {
  try {
    const blocks = [
      {
        type: 'input',
        block_id: 'title_block',
        element: {
          type: 'plain_text_input',
          action_id: 'title_input',
          placeholder: { type: 'plain_text', text: 'e.g. Q1 Sales Update, New Process Alert...' },
          max_length: 80,
        },
        label: { type: 'plain_text', text: '📌 Title', emoji: true },
      },
      {
        type: 'input',
        block_id: 'message_block',
        element: {
          type: 'plain_text_input',
          action_id: 'message_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Write your announcement here...' },
          min_length: 1,
          ...(prefillMessage ? { initial_value: prefillMessage } : {}),
        },
        label: { type: 'plain_text', text: 'Message', emoji: true },
      },
      {
        type: 'input',
        block_id: 'audience_block',
        optional: true,
        element: {
          type: 'multi_external_select',
          action_id: 'audience_select',
          placeholder: { type: 'plain_text', text: 'Search Slack user groups...' },
          min_query_length: 0,
        },
        label: { type: 'plain_text', text: '👥 Send to groups', emoji: true },
        hint: { type: 'plain_text', text: 'Type to search @-handle groups from Slack admin' },
      },
      {
        type: 'input',
        block_id: 'channel_block',
        optional: true,
        element: {
          type: 'multi_conversations_select',
          action_id: 'channel_select',
          placeholder: { type: 'plain_text', text: 'Pick channels...' },
          filter: { include: ['public', 'private'] },
        },
        label: { type: 'plain_text', text: '📢 Send to channels', emoji: true },
        hint: { type: 'plain_text', text: 'Posts visibly in the channel AND DMs all members for read receipts' },
      },
      {
        type: 'input',
        block_id: 'individual_block',
        optional: true,
        element: {
          type: 'multi_users_select',
          action_id: 'individual_users',
          placeholder: { type: 'plain_text', text: 'Add specific people (optional)' },
        },
        label: { type: 'plain_text', text: '🙋 Also send to individuals', emoji: true },
        hint: { type: 'plain_text', text: 'Optional: send to specific people on top of groups/channels above' },
      },
      {
        type: 'input',
        block_id: 'link_block',
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'link_input',
          placeholder: { type: 'plain_text', text: 'https://...' },
        },
        label: { type: 'plain_text', text: '🔗 Link (optional)', emoji: true },
        hint: { type: 'plain_text', text: 'Attach a doc, page, or resource to your announcement' },
      },
      {
        type: 'input',
        block_id: 'schedule_block',
        optional: true,
        element: {
          type: 'datetimepicker',
          action_id: 'schedule_at',
          placeholder: { type: 'plain_text', text: 'Send now' }
        },
        label: { type: 'plain_text', text: '🕐 Schedule for later (optional)', emoji: true }
      },
    ];
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'announce_modal_submit',
        title: { type: 'plain_text', text: '📣 Send Announcement', emoji: true },
        submit: { type: 'plain_text', text: 'Send', emoji: true },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks,
      },
    });
  } catch (error) {
    logger.error('Error opening announce modal:', error);
  }
}
// ============================================================
//  Message shortcut: Turn into Announcement
// ============================================================
app.shortcut('announce_from_message', async ({ ack, body, client, logger }) => {
  await ack();
  const messageText
