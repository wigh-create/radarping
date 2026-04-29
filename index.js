/**
 * Radar Ping — Tracked Slack Broadcasts with Read Receipts & Pulse Check-ins
 *
 * Commands:
 *   /announce        - Send a tracked announcement
 *   /radarping       - Alias for /announce
 *   /announce-status - Check read receipts for your announcements
 *   /radarpulse      - Send a pulse quiz / check-in
 *   /radarping-review - View & cancel pending scheduled posts
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

async function listAllChannelMembers(client, channel, logger) {
  const members = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const resp = await client.conversations.members({
      channel,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Failed to list channel members');
    }
    if (Array.isArray(resp.members)) members.push(...resp.members);
    cursor = resp.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  if (cursor) logger?.warn?.('listAllChannelMembers: pagination limit reached, results may be truncated');
  return [...new Set(members)].filter((id) => id && id !== 'USLACKBOT');
}
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
        hint: { type: 'plain_text', text: 'Posts visibly in the channel. Optionally DM & track all channel members (toggle below).' },
      },
      {
        type: 'input',
        block_id: 'channel_tracking_block',
        optional: true,
        element: {
          type: 'checkboxes',
          action_id: 'channel_tracking_checkbox',
          options: [
            {
              text: { type: 'plain_text', text: 'DM & track everyone in selected channels', emoji: true },
              value: 'include_channel_members',
            },
          ],
        },
        label: { type: 'plain_text', text: 'Channel tracking', emoji: true },
        hint: { type: 'plain_text', text: 'If unchecked: message posts in channel(s), but only selected groups/people get DMs and tracking.' },
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
        label: { type: 'plain_text', text: '🔗 Link', emoji: true },
        hint: { type: 'plain_text', text: 'Attach a doc, page, or resource to your announcement' },
      },
      {
        type: 'input',
        block_id: 'schedule_block',
        optional: true,
        element: {
          type: 'datetimepicker',
          action_id: 'schedule_at',
        },
        label: { type: 'plain_text', text: '🕐 Schedule for later', emoji: true },
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
  const messageText = body.message?.text || '';
  await openAnnounceModal({
    client,
    triggerId: body.trigger_id,
    prefillMessage: messageText,
    logger,
  });
});
// ============================================================
//  /announce - Open compose modal
// ============================================================
app.command('/announce', async ({ ack, body, client, logger }) => {
  await ack();
  const prefillMessage = (body.text || '').trim();
  await openAnnounceModal({ client, triggerId: body.trigger_id, prefillMessage, logger });
});
// ============================================================
//  /radarping - Alias for /announce
// ============================================================
app.command('/radarping', async ({ ack, body, client, logger }) => {
  await ack();
  const prefillMessage = (body.text || '').trim();
  await openAnnounceModal({ client, triggerId: body.trigger_id, prefillMessage, logger });
});
// ============================================================
//  Modal submit - send the announcement (or schedule it)
// ============================================================
app.view('announce_modal_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  const senderId = body.user.id;
  const senderName = body.user.name;
  const values = view.state.values;
  const title = values.title_block.title_input.value;
  const message = values.message_block.message_input.value;
  let linkUrl = values.link_block?.link_input?.value?.trim() || null;
  if (linkUrl && !linkUrl.match(/^https?:\/\//i)) {
    linkUrl = `https://${linkUrl}`;
  }
  const includeChannelMembers =
    (values.channel_tracking_block?.channel_tracking_checkbox?.selected_options || []).some(
      (o) => o.value === 'include_channel_members'
    );

  // ── SCHEDULE FORK ──────────────────────────────────────────────────────────
  const scheduleAt = values?.schedule_block?.schedule_at?.selected_date_time;
  if (scheduleAt) {
    const groupValues = values.audience_block?.audience_select?.selected_options?.map(o => o.value) || [];
    const selectedChannels = values.channel_block?.channel_select?.selected_conversations || [];
    const individualUsers = values.individual_block?.individual_users?.selected_users || [];

    const hasAudience = groupValues.length > 0 || selectedChannels.length > 0 || individualUsers.length > 0;
    if (!hasAudience) {
      await client.chat.postMessage({ channel: senderId, text: '❌ No audience selected. Pick a group, channel, or add individuals.' });
      return;
    }
    const usergroupIds = groupValues
      .filter((gv) => gv.startsWith('slack_ug:'))
      .map((gv) => gv.split(':')[1])
      .filter(Boolean);

    await createScheduledPost({
      type: 'announce',
      created_by: senderId,
      payload: {
        title,
        message,
        link: linkUrl,
        channels: selectedChannels,
        includeChannelMembers,
        usergroupIds,
        individualUsers,
      },
      scheduled_at: scheduleAt,
    });

    await client.chat.postMessage({
      channel: senderId,
      text: `✅ Announcement scheduled!`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *Announcement scheduled!*\n📣 *"${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"*\n\n⏰ Will be sent at the scheduled time.${selectedChannels.length ? `\n📢 Will post in *${selectedChannels.length}* channel${selectedChannels.length !== 1 ? 's' : ''}.` : ''}${includeChannelMembers ? `\n👥 Will DM & track all channel members.` : ''}`,
        },
      }],
    });
    return;
  }
  // ── END SCHEDULE FORK ──────────────────────────────────────────────────────

  // Groups (from external_select — user groups only)
  const groupValues = values.audience_block?.audience_select?.selected_options?.map(o => o.value) || [];
  // Channels (from multi_conversations_select — post visibly + DM members)
  const selectedChannels = values.channel_block?.channel_select?.selected_conversations || [];
  // Individuals
  const individualUsers = values.individual_block?.individual_users?.selected_users || [];
  const hasAudience = groupValues.length > 0 || selectedChannels.length > 0 || individualUsers.length > 0;
  if (!hasAudience) {
    await client.chat.postMessage({ channel: senderId, text: '❌ No audience selected. Pick a group, channel, or add individuals.' });
    return;
  }
  let userIds = [];
  const groupNameParts = [];
  let targetType = 'manual';
  let targetId = null;
  for (const gv of groupValues) {
    try {
      if (gv.startsWith('slack_ug:')) {
        const [, ugId, ugName] = gv.split(':');
        groupNameParts.push(ugName);
        targetType = 'usergroup';
        targetId = ugId;
        const membersRes = await client.usergroups.users.list({ usergroup: ugId });
        userIds = userIds.concat(membersRes.users || []);
      }
    } catch (err) { logger.error('Error resolving user group:', err); }
  }
  const channelPostTargets = [];
  for (const channelId of selectedChannels) {
    try {
      const chanInfo = await client.conversations.info({ channel: channelId });
      const chanName = chanInfo.channel?.name || channelId;
      groupNameParts.push(`#${chanName}`);
      channelPostTargets.push({ id: channelId, name: chanName });
      targetType = 'channel';
      targetId = channelId;
      if (includeChannelMembers) {
        const members = await listAllChannelMembers(client, channelId, logger);
        userIds = userIds.concat(members.filter((id) => id !== senderId));
      }
    } catch (err) { logger.error('Error resolving channel:', err); }
  }
  if (individualUsers.length > 0) {
    if (groupNameParts.length === 0) targetType = 'manual';
  }
  const allUserIds = [...new Set([...userIds, ...individualUsers])];
  let groupName;
  if (groupNameParts.length > 0) {
    groupName = groupNameParts.join(' + ');
    if (individualUsers.length > 0) groupName += ` + ${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  } else if (individualUsers.length > 0) {
    groupName = `${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  } else {
    groupName = 'Unknown Group';
  }
  if (allUserIds.length === 0 && channelPostTargets.length === 0) {
    await client.chat.postMessage({ channel: senderId, text: `❌ Couldn't resolve any recipients. Check the group has members, add individuals, or pick a channel.` });
    return;
  }
  userIds = allUserIds;
  const announcementId = randomUUID();
  await db.createAnnouncement({ id: announcementId, sender_id: senderId, sender_name: senderName, message, group_name: groupName, target_type: targetType, target_id: targetId });
  const recipientUsers = [];
  for (const uid of userIds) {
    try {
      const info = await client.users.info({ user: uid });
      const u = info.user;
      if (u.is_bot || u.deleted || u.id === senderId) continue;
      recipientUsers.push({ user_id: u.id, user_name: u.profile?.real_name || u.profile?.display_name || u.name });
    } catch {
      recipientUsers.push({ user_id: uid, user_name: uid });
    }
  }
  await db.addRecipients(announcementId, recipientUsers);
  await db.updateRecipientCount(announcementId, recipientUsers.length);
  const sentAt = new Date().toISOString();
  notion.createAnnouncementPage({
    announcementId, title, message, senderName, groupName,
    totalRecipients: recipientUsers.length, linkUrl, sentAt,
  }).then(announcementPageId => {
    if (announcementPageId && recipientUsers.length > 0) {
      notion.createRecipientRows({ announcementPageId, recipients: recipientUsers, sentAt });
    }
  });
  let sent = 0;
  for (const recipient of recipientUsers) {
    try {
      const dmResult = await client.chat.postMessage({
        channel: recipient.user_id,
        text: `📣 Announcement from <@${senderId}>: ${message}`,
        blocks: buildAnnouncementBlocks(title, message, senderId, announcementId, groupName, linkUrl),
      });
      if (dmResult?.ts) await db.storeDmTs(announcementId, recipient.user_id, dmResult.ts, dmResult.channel);
      sent++;
    } catch (err) { logger.warn(`Could not DM ${recipient.user_id}:`, err.message); }
  }
  for (const chan of channelPostTargets) {
    try {
      try { await client.conversations.join({ channel: chan.id }); } catch {}
      await client.chat.postMessage({
        channel: chan.id,
        text: `📣 Announcement from <@${senderId}>: ${message}`,
        blocks: buildAnnouncementBlocks(title, message, senderId, announcementId, groupName, linkUrl),
      });
    } catch (err) { logger.warn(`Could not post to channel ${chan.name}:`, err.message); }
  }
  const confirmBlocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: `✅ *Announcement sent!*\n📣 *"${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"*\n\n👥 Sent to *${groupName}* — *${sent}/${recipientUsers.length}* DMs delivered.` },
  }];
  if (channelPostTargets.length > 0) {
    const channelList = channelPostTargets.map(c => `#${c.name}`).join(', ');
    confirmBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📢 Also posted visibly in ${channelList}.${includeChannelMembers ? ' All channel members are being tracked for read receipts.' : ' Only selected groups/people are being tracked (channel viewers can still click to mark read).'}`
      }
    });
  }
  confirmBlocks.push(
    { type: 'section', text: { type: 'mrkdwn', text: `Track read receipts with:\n\`/announce-status ${announcementId.slice(0, 8)}\`` } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '📊 Check Read Receipts', emoji: true }, action_id: 'check_status', value: announcementId, style: 'primary' }] }
  );
  await client.chat.postMessage({ channel: senderId, text: `✅ Announcement sent to *${groupName}*`, blocks: confirmBlocks });
});
// ============================================================
//  Read receipt button click
// ============================================================
app.action('mark_as_read', async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const announcementId = action.value;
  let userName = body.user.name || userId;
  try {
    const info = await client.users.info({ user: userId });
    userName = info.user?.profile?.real_name || info.user?.profile?.display_name || info.user?.name || userId;
  } catch {}
  await db.addRecipients(announcementId, [{ user_id: userId, user_name: userName }]);
  const alreadyRead = (await db.getRecipient(announcementId, userId))?.read_at;
  await db.markRead(announcementId, userId);
  if (!alreadyRead) {
    const stats = await db.getRecipientStats(announcementId);
    notion.markRecipientRead({ announcementId, userId, userName });
    notion.updateReadStats({ announcementId, readCount: stats.read_count, pendingCount: stats.total - stats.read_count, totalRecipients: stats.total });
  }
  const readBlocks = (originalBlocks) => [
    ...originalBlocks.slice(0, -1),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `✅ *You confirmed reading this* at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|just now>` }] },
  ];
  const clickedInChannel = body.channel?.id && !body.channel.id.startsWith('D');
  if (clickedInChannel) {
    try {
      await client.chat.postEphemeral({ channel: body.channel.id, user: userId, text: `✅ Got it — marked as read.` });
    } catch (err) { logger.warn('Could not send ephemeral read confirmation:', err.message); }
    try {
      const recipientInfo = await db.getRecipient(announcementId, userId);
      if (recipientInfo?.dm_ts && recipientInfo.dm_channel) {
        const dmMsg = await client.conversations.history({ channel: recipientInfo.dm_channel, latest: recipientInfo.dm_ts, limit: 1, inclusive: true });
        const dmBlocks = dmMsg?.messages?.[0]?.blocks;
        if (dmBlocks) {
          await client.chat.update({ channel: recipientInfo.dm_channel, ts: recipientInfo.dm_ts, text: '✅ You\'ve confirmed you\'ve read this announcement.', blocks: readBlocks(dmBlocks) });
        }
      }
    } catch (err) { logger.warn('Could not update DM after channel read:', err.message); }
  } else {
    try {
      await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: '✅ You\'ve confirmed you\'ve read this announcement.', blocks: readBlocks(body.message.blocks) });
    } catch (err) { logger.warn('Could not update DM on read:', err.message); }
  }
  try {
    const announcement = await db.getAnnouncement(announcementId);
    const stats = await db.getRecipientStats(announcementId);
    if (announcement) {
      await client.chat.postMessage({
        channel: announcement.sender_id,
        text: `👁️ <@${userId}> just read your announcement`,
        blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `👁️ <@${userId}> marked your announcement as read. *${stats.read_count}/${stats.total}* have now read it.` }] }],
      });
    }
  } catch (err) { logger.warn('Could not notify sender:', err.message); }
});
// ============================================================
//  Check status button
// ============================================================
app.action('check_status', async ({ ack, body, action, client, logger }) => {
  await ack();
  await sendStatusReport(client, body.user.id, action.value, logger);
});
// ============================================================
//  /announce-status - View read receipt dashboard
// ============================================================
app.command('/announce-status', async ({ ack, body, client, logger }) => {
  await ack();
  const senderId = body.user.id;
  const args = (body.text || '').trim();
  if (args) {
    const recent = await db.getRecentAnnouncements(senderId, 20);
    const match = recent.find(a => a.id.startsWith(args) || a.id === args);
    if (match) {
      await sendStatusReport(client, senderId, match.id, logger);
    } else {
      await client.chat.postMessage({ channel: senderId, text: `❌ No announcement found matching \`${args}\`. Try \`/announce-status\` (no args) to see your recent announcements.` });
    }
  } else {
    const recent = await db.getRecentAnnouncements(senderId, 10);
    if (recent.length === 0) {
      await client.chat.postMessage({ channel: senderId, text: '📭 You haven\'t sent any announcements yet. Use `/announce` to send one!' });
      return;
    }
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: '📣 Your Recent Announcements', emoji: true } },
      { type: 'divider' },
    ];
    for (const ann of recent) {
      const stats = await db.getRecipientStats(ann.id);
      const pct = stats.total > 0 ? Math.round((stats.read_count / stats.total) * 100) : 0;
      const bar = buildProgressBar(pct);
      const date = new Date(ann.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*"${ann.message.slice(0, 80)}${ann.message.length > 80 ? '...' : ''}"*\n👥 *${ann.group_name}* · 📅 ${date}\n${bar} *${stats.read_count}/${stats.total}* read (${pct}%)` },
        accessory: { type: 'button', text: { type: 'plain_text', text: '📊 Details', emoji: true }, action_id: 'check_status', value: ann.id },
      });
      blocks.push({ type: 'divider' });
    }
    await client.chat.postMessage({ channel: senderId, blocks, text: 'Your recent announcements' });
  }
});
// ============================================================
//  Helpers
// ============================================================
function buildAnnouncementBlocks(title, message, senderId, announcementId, groupName, linkUrl = null) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `📣 ${title}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent by <@${senderId}>` }] },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: message } },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        linkUrl
          ? { type: 'button', text: { type: 'plain_text', text: '📖 Open to Read', emoji: true }, action_id: 'mark_as_read', value: announcementId, url: linkUrl, style: 'primary' }
          : { type: 'button', text: { type: 'plain_text', text: '✅ Mark as Read', emoji: true }, action_id: 'mark_as_read', value: announcementId, style: 'primary', confirm: { title: { type: 'plain_text', text: 'Confirm you\'ve read this' }, text: { type: 'plain_text', text: 'This will notify the sender that you\'ve read the announcement.' }, confirm: { type: 'plain_text', text: 'Yes, I\'ve read it' }, deny: { type: 'plain_text', text: 'Cancel' } } },
      ],
    },
  ];
}
async function sendStatusReport(client, requesterId, announcementId, logger) {
  const announcement = await db.getAnnouncement(announcementId);
  if (!announcement) { await client.chat.postMessage({ channel: requesterId, text: '❌ Announcement not found.' }); return; }
  const stats = await db.getRecipientStats(announcementId);
  const pending = await db.getPendingReaders(announcementId);
  const all = await db.getAllReaders(announcementId);
  const pct = stats.total > 0 ? Math.round((stats.read_count / stats.total) * 100) : 0;
  const bar = buildProgressBar(pct);
  const date = new Date(announcement.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const readList = all.filter(r => r.read_at).map(r => `✅ <@${r.user_id}>`).join('  ');
  const pendingList = pending.slice(0, 20).map(r => `⏳ <@${r.user_id}>`).join('  ');
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📊 Read Receipt Report', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*"${announcement.message.slice(0, 120)}${announcement.message.length > 120 ? '...' : ''}"*\n📅 Sent ${date} to *${announcement.group_name}*` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `${bar}  *${stats.read_count}/${stats.total}* have read this (${pct}%)` } },
  ];
  if (readList) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*✅ Read (${stats.read_count}):*\n${readList || '_none yet_'}` } });
  if (pendingList) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*⏳ Not yet read (${pending.length}):*\n${pendingList}${pending.length > 20 ? `\n_...and ${pending.length - 20} more_` : ''}` } });
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '👋 Nudge Unread People', emoji: true }, action_id: 'nudge_unread', value: announcementId, style: 'danger' }] });
  }
  await client.chat.postMessage({ channel: requesterId, blocks, text: 'Read receipt report' });
}
// ============================================================
//  Nudge unread recipients
// ============================================================
app.action('nudge_unread', async ({ ack, body, action, client, logger }) => {
  await ack();
  const announcementId = action.value;
  const announcement = await db.getAnnouncement(announcementId);
  const pending = await db.getPendingReaders(announcementId);
  if (!announcement || pending.length === 0) { await client.chat.postMessage({ channel: body.user.id, text: '✅ Everyone has read it already!' }); return; }
  let nudged = 0;
  for (const recipient of pending) {
    try {
      await client.chat.postMessage({
        channel: recipient.user_id,
        text: `👋 Reminder from <@${announcement.sender_id}>: you haven\'t marked this announcement as read yet.`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `👋 *Reminder:* <@${announcement.sender_id}> is waiting for your read confirmation on this announcement:\n\n_"${announcement.message.slice(0, 200)}${announcement.message.length > 200 ? '...' : ''}"_` } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '✅ Mark as Read', emoji: true }, action_id: 'mark_as_read', value: announcementId, style: 'primary' }] },
        ],
      });
      nudged++;
    } catch (err) { logger.warn(`Could not nudge ${recipient.user_id}:`, err.message); }
  }
  await client.chat.postMessage({ channel: body.user.id, text: `👋 Nudged ${nudged} people who haven't read it yet.` });
});
function buildProgressBar(pct) {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
// ============================================================
//  /radarpulse - Pulse quiz / check-in builder
// ============================================================
app.command('/radarpulse', async ({ ack, body, client, logger }) => {
  await ack();
  await openPulseModal({ client, triggerId: body.trigger_id, logger });
});
const pulseModalCache = new Map();
async function openPulseModal({ client, triggerId, logger }) {
  try {
    const sessionId = randomUUID();
    pulseModalCache.set(sessionId, {});
    setTimeout(() => pulseModalCache.delete(sessionId), 60 * 60 * 1000);
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'pulse_modal_submit',
        title: { type: 'plain_text', text: '📊 Send Pulse', emoji: true },
        submit: { type: 'plain_text', text: 'Send Pulse →', emoji: true },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: buildPulseModalBlocks(),
        private_metadata: JSON.stringify({ sessionId }),
      },
    });
  } catch (error) {
    logger.error('Error opening pulse modal:', error);
  }
}
// ------------------------------------------------------------
//  buildPulseModalBlocks — dynamic growth version
//  Field order: Title → Groups → Channels → Individuals → [divider] → Questions → Schedule
// ------------------------------------------------------------
function buildPulseModalBlocks(questionsVisible = 1, visibleLabelBlocks = new Set(), visibleChoiceBlocks = new Set()) {
  const blocks = [
    {
      type: 'input',
      block_id: 'pulse_title_block',
      element: { type: 'plain_text_input', action_id: 'pulse_title_input', placeholder: { type: 'plain_text', text: 'e.g. Q1 Team Health Check, Sprint Retro Pulse...' }, max_length: 80 },
      label: { type: 'plain_text', text: '📌 Pulse Title', emoji: true },
    },
    {
      type: 'input',
      block_id: 'pulse_audience_block',
      optional: true,
      element: { type: 'multi_external_select', action_id: 'pulse_audience_select', placeholder: { type: 'plain_text', text: 'Search Slack user groups...' }, min_query_length: 0 },
      label: { type: 'plain_text', text: '👥 Send to groups', emoji: true },
      hint: { type: 'plain_text', text: 'Type to search @-handle groups from Slack admin' },
    },
    {
      type: 'input',
      block_id: 'pulse_channel_block',
      optional: true,
      element: { type: 'multi_conversations_select', action_id: 'pulse_channel_select', placeholder: { type: 'plain_text', text: 'Pick channels...' }, filter: { include: ['public', 'private'] } },
      label: { type: 'plain_text', text: '📢 Send to channels', emoji: true },
      hint: { type: 'plain_text', text: 'Posts the pulse in the channel. Optionally DM everyone in the channel (toggle below).' },
    },
    {
      type: 'input',
      block_id: 'pulse_channel_tracking_block',
      optional: true,
      element: {
        type: 'checkboxes',
        action_id: 'pulse_channel_tracking_checkbox',
        options: [
          {
            text: { type: 'plain_text', text: 'DM everyone in selected channels', emoji: true },
            value: 'include_channel_members',
          },
        ],
      },
      label: { type: 'plain_text', text: 'Channel audience expansion', emoji: true },
      hint: { type: 'plain_text', text: 'If unchecked: pulse posts in channel(s), but only selected groups/people get the DM.' },
    },
    {
      type: 'input',
      block_id: 'pulse_individuals_block',
      optional: true,
      element: { type: 'multi_users_select', action_id: 'pulse_individuals_input', placeholder: { type: 'plain_text', text: 'Add specific people (optional)' } },
      label: { type: 'plain_text', text: '🙋 Also send to individuals', emoji: true },
    },
    { type: 'divider' },
  ];
  for (let i = 1; i <= questionsVisible; i++) {
    const required = i === 1;
    blocks.push(...buildQuestionBlocks(i, required, visibleLabelBlocks.has(`pulse_q${i}_type_block`), visibleChoiceBlocks.has(`pulse_q${i}_type_block`)));
  }
  if (questionsVisible < 20) {
    const next = questionsVisible + 1;
    blocks.push({
      type: 'actions',
      block_id: `pulse_add_q${next}_block`,
      elements: [{ type: 'button', text: { type: 'plain_text', text: `➕ Add question ${next}`, emoji: true }, action_id: `add_question_${next}`, value: `add_${next}` }],
    });
  }
  blocks.push({
    type: 'input',
    block_id: 'schedule_block',
    optional: true,
    element: {
      type: 'datetimepicker',
      action_id: 'schedule_at',
    },
    label: { type: 'plain_text', text: '🕐 Schedule for later', emoji: true },
  });
  return blocks;
}
// ------------------------------------------------------------
//  buildQuestionBlocks — renders one question slot
// ------------------------------------------------------------
function buildQuestionBlocks(num, required, showLabels = false, showChoices = false) {
  const label = required ? `Question ${num}` : `Question ${num} (optional)`;
  const blocks = [
    {
      type: 'input',
      block_id: `pulse_q${num}_text_block`,
      optional: !required,
      element: { type: 'plain_text_input', action_id: `pulse_q${num}_text_input`, placeholder: { type: 'plain_text', text: 'e.g. How energised do you feel this week?' }, max_length: 300 },
      label: { type: 'plain_text', text: `❓ ${label}`, emoji: true },
    },
    {
      type: 'input',
      block_id: `pulse_q${num}_type_block`,
      optional: !required,
      dispatch_action: true,
      element: {
        type: 'static_select',
        action_id: `pulse_q${num}_type_input`,
        placeholder: { type: 'plain_text', text: 'Response type' },
        options: [
          { text: { type: 'plain_text', text: 'Scale 1–10', emoji: true }, value: 'scale_10' },
          { text: { type: 'plain_text', text: 'Scale 1–5', emoji: true }, value: 'scale_5' },
          { text: { type: 'plain_text', text: 'Free text', emoji: true }, value: 'free_text' },
          { text: { type: 'plain_text', text: 'Multiple choice', emoji: true }, value: 'multi_select' },
        ],
        initial_option: { text: { type: 'plain_text', text: 'Scale 1–10', emoji: true }, value: 'scale_10' },
      },
      label: { type: 'plain_text', text: '📏 Response type', emoji: true },
    },
  ];
  if (showLabels) {
    blocks.push(
      { type: 'input', block_id: `pulse_q${num}_low_block`, optional: true, element: { type: 'plain_text_input', action_id: `pulse_q${num}_low_input`, placeholder: { type: 'plain_text', text: 'e.g. Not at all' }, max_length: 50 }, label: { type: 'plain_text', text: `↙️ Low label (optional)`, emoji: true } },
      { type: 'input', block_id: `pulse_q${num}_high_block`, optional: true, element: { type: 'plain_text_input', action_id: `pulse_q${num}_high_input`, placeholder: { type: 'plain_text', text: 'e.g. Extremely' }, max_length: 50 }, label: { type: 'plain_text', text: `↗️ High label (optional)`, emoji: true } }
    );
  }
  if (showChoices) {
    blocks.push(
      { type: 'input', block_id: `pulse_q${num}_choice1_block`, optional: false, element: { type: 'plain_text_input', action_id: `pulse_q${num}_choice1_input`, placeholder: { type: 'plain_text', text: 'Choice 1' }, max_length: 75 }, label: { type: 'plain_text', text: '1️⃣ Choice 1', emoji: true } },
      { type: 'input', block_id: `pulse_q${num}_choice2_block`, optional: true, element: { type: 'plain_text_input', action_id: `pulse_q${num}_choice2_input`, placeholder: { type: 'plain_text', text: 'Choice 2 (optional)' }, max_length: 75 }, label: { type: 'plain_text', text: '2️⃣ Choice 2', emoji: true } },
      { type: 'input', block_id: `pulse_q${num}_choice3_block`, optional: true, element: { type: 'plain_text_input', action_id: `pulse_q${num}_choice3_input`, placeholder: { type: 'plain_text', text: 'Choice 3 (optional)' }, max_length: 75 }, label: { type: 'plain_text', text: '3️⃣ Choice 3', emoji: true } },
      { type: 'input', block_id: `pulse_q${num}_choice4_block`, optional: true, element: { type: 'plain_text_input', action_id: `pulse_q${num}_choice4_input`, placeholder: { type: 'plain_text', text: 'Choice 4 (optional)' }, max_length: 75 }, label: { type: 'plain_text', text: '4️⃣ Choice 4', emoji: true } },
      { type: 'input', block_id: `pulse_q${num}_free_text_block`, optional: true, element: { type: 'checkboxes', action_id: `pulse_q${num}_free_text_input`, options: [{ text: { type: 'plain_text', text: 'Also allow free text response', emoji: true }, value: 'allow_free_text' }] }, label: { type: 'plain_text', text: '✏️ Optional free fill', emoji: true } }
    );
  }
  return blocks;
}
// ============================================================
//  Helper: derive current modal state from view blocks
// ============================================================
function getPulseViewState(view) {
  const blocks = view.blocks || [];
  let questionsVisible = 0;
  const visibleLabelBlocks = new Set();
  const visibleChoiceBlocks = new Set();
  for (const b of blocks) {
    if (b.block_id && /^pulse_q\d+_text_block$/.test(b.block_id)) questionsVisible++;
    if (b.block_id && /^pulse_q\d+_type_block$/.test(b.block_id)) {
      const num = b.block_id.match(/pulse_q(\d+)_type_block/)[1];
      const hasLow = blocks.some(lb => lb.block_id === `pulse_q${num}_low_block`);
      if (hasLow) visibleLabelBlocks.add(`pulse_q${num}_type_block`);
      const hasChoices = blocks.some(lb => lb.block_id === `pulse_q${num}_choice1_block`);
      if (hasChoices) visibleChoiceBlocks.add(`pulse_q${num}_type_block`);
    }
  }
  return { questionsVisible: Math.max(questionsVisible, 1), visibleLabelBlocks, visibleChoiceBlocks };
}
// ============================================================
//  block_actions: "+ Add question N" buttons
// ============================================================
app.action(/^add_question_(\d+)$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const view = body.view;
  const { questionsVisible, visibleLabelBlocks, visibleChoiceBlocks } = getPulseViewState(view);
  const targetQ = parseInt(action.action_id.replace('add_question_', ''), 10);
  const newVisible = Math.max(questionsVisible, targetQ);
  const newBlocks = buildPulseModalBlocks(newVisible, visibleLabelBlocks, visibleChoiceBlocks);
  try {
    await client.views.update({
      view_id: view.id, hash: view.hash,
      view: { type: 'modal', callback_id: 'pulse_modal_submit', title: { type: 'plain_text', text: '📊 Send Pulse', emoji: true }, submit: { type: 'plain_text', text: 'Send Pulse →', emoji: true }, close: { type: 'plain_text', text: 'Cancel' }, blocks: newBlocks, private_metadata: view.private_metadata },
    });
  } catch (err) { logger.error('add_question view.update error:', err); }
});
// ============================================================
//  block_actions: response type dropdown — smart label reveal
// ============================================================
app.action(/^pulse_q(\d+)_type_input$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const view = body.view;
  const num = action.action_id.match(/pulse_q(\d+)_type_input/)[1];
  const selectedType = action.selected_option?.value;
  const { questionsVisible, visibleLabelBlocks, visibleChoiceBlocks } = getPulseViewState(view);
  const typeBlockId = `pulse_q${num}_type_block`;
  if (selectedType === 'scale_10' || selectedType === 'scale_5') {
    visibleLabelBlocks.add(typeBlockId);
    visibleChoiceBlocks.delete(typeBlockId);
  } else if (selectedType === 'multi_select') {
    visibleChoiceBlocks.add(typeBlockId);
    visibleLabelBlocks.delete(typeBlockId);
  } else {
    visibleLabelBlocks.delete(typeBlockId);
    visibleChoiceBlocks.delete(typeBlockId);
  }
  const newBlocks = buildPulseModalBlocks(questionsVisible, visibleLabelBlocks, visibleChoiceBlocks);
  try {
    await client.views.update({
      view_id: view.id, hash: view.hash,
      view: { type: 'modal', callback_id: 'pulse_modal_submit', title: { type: 'plain_text', text: '📊 Send Pulse', emoji: true }, submit: { type: 'plain_text', text: 'Send Pulse →', emoji: true }, close: { type: 'plain_text', text: 'Cancel' }, blocks: newBlocks, private_metadata: view.private_metadata },
    });
  } catch (err) { logger.error('pulse type dropdown view.update error:', err); }
});
// ============================================================
//  Pulse modal submission (or schedule it)
// ============================================================
app.view('pulse_modal_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  const senderId = body.user.id;
  const senderName = body.user.name;
  const values = view.state.values;
  const title = values.pulse_title_block.pulse_title_input.value;
  const includePulseChannelMembers =
    (values.pulse_channel_tracking_block?.pulse_channel_tracking_checkbox?.selected_options || []).some(
      (o) => o.value === 'include_channel_members'
    );

  // ── SCHEDULE FORK ──────────────────────────────────────────────────────────
  const scheduleAt = values?.schedule_block?.schedule_at?.selected_date_time;
  if (scheduleAt) {
    const questions = [];
    for (let i = 1; i <= 20; i++) {
      const text = values[`pulse_q${i}_text_block`]?.[`pulse_q${i}_text_input`]?.value;
      const responseType = values[`pulse_q${i}_type_block`]?.[`pulse_q${i}_type_input`]?.selected_option?.value;
      const lowLabel = values[`pulse_q${i}_low_block`]?.[`pulse_q${i}_low_input`]?.value || null;
      const highLabel = values[`pulse_q${i}_high_block`]?.[`pulse_q${i}_high_input`]?.value || null;
      const choice1 = values[`pulse_q${i}_choice1_block`]?.[`pulse_q${i}_choice1_input`]?.value || null;
      const choice2 = values[`pulse_q${i}_choice2_block`]?.[`pulse_q${i}_choice2_input`]?.value || null;
      const choice3 = values[`pulse_q${i}_choice3_block`]?.[`pulse_q${i}_choice3_input`]?.value || null;
      const choice4 = values[`pulse_q${i}_choice4_block`]?.[`pulse_q${i}_choice4_input`]?.value || null;
      const choices = [choice1, choice2, choice3, choice4].filter(Boolean);
      const allowFreeText = (values[`pulse_q${i}_free_text_block`]?.[`pulse_q${i}_free_text_input`]?.selected_options || []).some(o => o.value === 'allow_free_text');
      if (text && responseType) questions.push({ index: questions.length, text, response_type: responseType, low_label: lowLabel, high_label: highLabel, ...(choices.length ? { choices } : {}), ...(allowFreeText ? { allow_free_text: true } : {}) });
    }
    if (questions.length === 0) { await client.chat.postMessage({ channel: senderId, text: '❌ Please add at least one question to your pulse.' }); return; }

    const groupValues = values.pulse_audience_block?.pulse_audience_select?.selected_options?.map(o => o.value) || [];
    const selectedChannels = values.pulse_channel_block?.pulse_channel_select?.selected_conversations || [];
    const individualUsers = values.pulse_individuals_block?.pulse_individuals_input?.selected_users || [];
    const hasAudience = groupValues.length > 0 || selectedChannels.length > 0 || individualUsers.length > 0;
    if (!hasAudience) { await client.chat.postMessage({ channel: senderId, text: '❌ No audience selected. Pick a group, channel, or add individuals.' }); return; }
    const usergroupIds = groupValues
      .filter((gv) => gv.startsWith('slack_ug:'))
      .map((gv) => gv.split(':')[1])
      .filter(Boolean);

    await createScheduledPost({
      type: 'pulse',
      created_by: senderId,
      payload: {
        title,
        questions,
        created_by: senderId,
        channels: selectedChannels,
        includeChannelMembers: includePulseChannelMembers,
        usergroupIds,
        individualUsers,
      },
      scheduled_at: scheduleAt,
    });

    await client.chat.postMessage({
      channel: senderId,
      text: `✅ Pulse scheduled!`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *Pulse scheduled!*\n📊 *"${title}"*\n\n⏰ Will be sent at the scheduled time with ${questions.length} question${questions.length !== 1 ? 's' : ''}.${selectedChannels.length ? `\n📢 Will post in *${selectedChannels.length}* channel${selectedChannels.length !== 1 ? 's' : ''}.` : ''}${includePulseChannelMembers ? `\n👥 Will DM all channel members.` : ''}` } }],
    });
    return;
  }
  // ── END SCHEDULE FORK ──────────────────────────────────────────────────────

  const groupValues = values.pulse_audience_block?.pulse_audience_select?.selected_options?.map(o => o.value) || [];
  const selectedChannels = values.pulse_channel_block?.pulse_channel_select?.selected_conversations || [];
  const individualUsers = values.pulse_individuals_block?.pulse_individuals_input?.selected_users || [];
  const questions = [];
  for (let i = 1; i <= 20; i++) {
    const text = values[`pulse_q${i}_text_block`]?.[`pulse_q${i}_text_input`]?.value;
    const responseType = values[`pulse_q${i}_type_block`]?.[`pulse_q${i}_type_input`]?.selected_option?.value;
    const lowLabel = values[`pulse_q${i}_low_block`]?.[`pulse_q${i}_low_input`]?.value || null;
    const highLabel = values[`pulse_q${i}_high_block`]?.[`pulse_q${i}_high_input`]?.value || null;
    const choice1 = values[`pulse_q${i}_choice1_block`]?.[`pulse_q${i}_choice1_input`]?.value || null;
    const choice2 = values[`pulse_q${i}_choice2_block`]?.[`pulse_q${i}_choice2_input`]?.value || null;
    const choice3 = values[`pulse_q${i}_choice3_block`]?.[`pulse_q${i}_choice3_input`]?.value || null;
    const choice4 = values[`pulse_q${i}_choice4_block`]?.[`pulse_q${i}_choice4_input`]?.value || null;
    const choices = [choice1, choice2, choice3, choice4].filter(Boolean);
    const allowFreeText = (values[`pulse_q${i}_free_text_block`]?.[`pulse_q${i}_free_text_input`]?.selected_options || []).some(o => o.value === 'allow_free_text');
    if (text && responseType) questions.push({ index: questions.length, text, response_type: responseType, low_label: lowLabel, high_label: highLabel, ...(choices.length ? { choices } : {}), ...(allowFreeText ? { allow_free_text: true } : {}) });
  }
  if (questions.length === 0) { await client.chat.postMessage({ channel: senderId, text: '❌ Please add at least one question to your pulse.' }); return; }
  const hasAudience = groupValues.length > 0 || selectedChannels.length > 0 || individualUsers.length > 0;
  if (!hasAudience) { await client.chat.postMessage({ channel: senderId, text: '❌ No audience selected. Pick a group, channel, or add individuals.' }); return; }
  const { userIds, groupName, targetType, targetRaw, channelPostTargets } = await resolvePulseAudience(client, groupValues, selectedChannels, individualUsers, senderId, includePulseChannelMembers, logger);
  if (userIds.length === 0 && channelPostTargets.length === 0) { await client.chat.postMessage({ channel: senderId, text: `❌ Couldn't resolve any recipients. Check the group has members, add individuals, or pick a channel.` }); return; }
  let senderDisplayName = senderName;
  try {
    const senderInfo = await client.users.info({ user: senderId });
    senderDisplayName = senderInfo.user?.profile?.real_name || senderInfo.user?.profile?.display_name || senderName;
  } catch {}
  const recipientUsers = [];
  for (const uid of userIds) {
    try {
      const info = await client.users.info({ user: uid });
      const u = info.user;
      if (u.is_bot || u.deleted || u.id === senderId) continue;
      recipientUsers.push({ user_id: u.id, display_name: u.profile?.real_name || u.profile?.display_name || u.name });
    } catch { recipientUsers.push({ user_id: uid, display_name: uid }); }
  }
  if (recipientUsers.length === 0 && channelPostTargets.length === 0) { await client.chat.postMessage({ channel: senderId, text: `❌ No valid recipients found after filtering bots and inactive users.` }); return; }
  const campaignId = randomUUID();
  const sentAt = new Date().toISOString();
  await db.createPulseCampaign({ id: campaignId, title, sender_slack_id: senderId, target_raw: targetRaw, target_type: targetType, resolved_users: recipientUsers.map(u => u.user_id), questions });
  notion.createPulseCampaignRow({ campaignId, title, senderName: senderDisplayName, targetRaw, totalRecipients: recipientUsers.length, sentAt, questionsJson: JSON.stringify(questions.map(q => q.text)) })
    .then(pageId => { if (pageId) db.updatePulseCampaignNotionId(campaignId, pageId); })
    .catch(err => logger.warn('Notion pulse campaign sync failed:', err.message));
  let sent = 0;
  for (const recipient of recipientUsers) {
    try {
      const responseId = randomUUID();
      await db.createPulseResponse({ id: responseId, campaign_id: campaignId, slack_user_id: recipient.user_id, slack_display_name: recipient.display_name });
      const dmBlocks = buildPulseDMBlocks({ id: campaignId, title, questions }, 0, null);
      const dmResult = await client.chat.postMessage({ channel: recipient.user_id, text: `📊 ${title} — pulse check-in from <@${senderId}>`, blocks: dmBlocks });
      if (dmResult?.ts) await db.createPulseState({ id: randomUUID(), campaign_id: campaignId, slack_user_id: recipient.user_id, dm_ts: dmResult.ts, dm_channel: dmResult.channel });
      sent++;
    } catch (err) { logger.warn(`Could not DM pulse to ${recipient.user_id}:`, err.message); }
  }
  for (const chan of channelPostTargets) {
    try {
      try { await client.conversations.join({ channel: chan.id }); } catch {}
      const channelBlocks = buildPulseDMBlocks({ id: campaignId, title, questions }, 0, null);
      const channelResult = await client.chat.postMessage({ channel: chan.id, text: `📊 ${title} — pulse check-in from <@${senderId}>`, blocks: channelBlocks });
      if (channelResult?.ts) await db.storePulseChannelPost(campaignId, channelResult.channel, channelResult.ts);
    } catch (err) { logger.warn(`Could not post pulse to channel ${chan.name}:`, err.message); }
  }
  let confirmText = `*"${title}"* has been sent to *${sent}* recipient${sent !== 1 ? 's' : ''}.`;
  if (channelPostTargets.length > 0) confirmText += ` Also posted in ${channelPostTargets.map(c => `#${c.name}`).join(', ')}.`;
  confirmText += `\n\n📋 *${questions.length} question${questions.length !== 1 ? 's' : ''}* · 👥 *${groupName}*\n\nResponses will be collected automatically as people answer.`;
  await client.chat.postMessage({
    channel: senderId,
    text: `✅ Pulse *"${title}"* sent to *${sent}* recipient${sent !== 1 ? 's' : ''}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '✅ Pulse Sent!', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: confirmText } },
    ],
  });
});
// FIX: use regex to match pulse_scale_1 through pulse_scale_10
app.action(/^pulse_scale_\d+$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const [campaignId, questionIndexStr, scoreStr] = (action.value || '').split(':');
  const questionIndex = parseInt(questionIndexStr, 10);
  const score = parseInt(scoreStr, 10);
  if (!campaignId || isNaN(questionIndex) || isNaN(score)) { logger.warn('pulse_scale_button: invalid action value', action.value); return; }
  await handlePulseAnswer({ client, logger, userId, campaignId, questionIndex, answer: score, score, body });
});
// ============================================================
//  Pulse: multi-select choice button click
// ============================================================
app.action(/^pulse_multiselect_\d+$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const [campaignId, questionIndexStr, choiceIndexStr] = (action.value || '').split(':');
  const questionIndex = parseInt(questionIndexStr, 10);
  const choiceIndex = parseInt(choiceIndexStr, 10);
  if (!campaignId || isNaN(questionIndex) || isNaN(choiceIndex)) { logger.warn('pulse_multiselect: invalid action value', action.value); return; }
  const campaign = await db.getPulseCampaign(campaignId);
  if (!campaign) { logger.warn(`pulse_multiselect: campaign ${campaignId} not found`); return; }
  const choices = campaign.questions[questionIndex]?.choices || [];
  const answer = choices[choiceIndex] ?? `Choice ${choiceIndex + 1}`;
  await handlePulseAnswer({ client, logger, userId, campaignId, questionIndex, answer, score: null, body });
});
// ============================================================
//  Pulse: free text submit button click
// ============================================================
app.action('pulse_text_submit', async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const [campaignId, questionIndexStr] = (action.value || '').split(':');
  const questionIndex = parseInt(questionIndexStr, 10);
  if (!campaignId || isNaN(questionIndex)) { logger.warn('pulse_text_submit: invalid action value', action.value); return; }
  const blockId = `pulse_text_input_${questionIndex}`;
  const textValue = body.state?.values?.[blockId]?.pulse_text_value?.value || '';
  await handlePulseAnswer({ client, logger, userId, campaignId, questionIndex, answer: textValue, score: null, body });
});
// ============================================================
//  Shared pulse answer handler
// ============================================================
async function handlePulseAnswer({ client, logger, userId, campaignId, questionIndex, answer, score, body }) {
  try {
    const campaign = await db.getPulseCampaign(campaignId);
    if (!campaign) { logger.warn(`handlePulseAnswer: campaign ${campaignId} not found`); return; }
    let state = await db.getPulseState(campaignId, userId);
    if (!state) {
      logger.info(`handlePulseAnswer: no state for ${userId} — auto-registering from channel click`);
      let existingResponse = await db.getPulseResponseByUser(campaignId, userId);
      if (!existingResponse) {
        let displayName = userId;
        try {
          const info = await client.users.info({ user: userId });
          displayName = info.user?.profile?.real_name || info.user?.profile?.display_name || info.user?.name || userId;
        } catch {}
        const responseId = randomUUID();
        await db.createPulseResponse({ id: responseId, campaign_id: campaignId, slack_user_id: userId, slack_display_name: displayName });
      }
      await db.createPulseState({ id: randomUUID(), campaign_id: campaignId, slack_user_id: userId, dm_ts: null, dm_channel: null });
      state = await db.getPulseState(campaignId, userId);
      if (!state) { logger.warn(`handlePulseAnswer: could not create state for ${userId}`); return; }
    }
    if (questionIndex !== state.current_question_index) { logger.warn(`handlePulseAnswer: stale click — expected q${state.current_question_index}, got q${questionIndex}`); return; }
    const questions = campaign.questions;
    const currentQuestion = questions[questionIndex];
    const response = await db.getPulseResponseByUser(campaignId, userId);
    if (!response) { logger.warn(`handlePulseAnswer: no response row for ${userId} / ${campaignId}`); return; }
    const answers = Array.isArray(response.answers) ? response.answers : [];
    answers[questionIndex] = { question_index: questionIndex, question_text: currentQuestion.text, response_type: currentQuestion.response_type, answer, score: score != null ? score : null };
    await db.updatePulseResponseAnswers(response.id, answers);
    const nextIndex = questionIndex + 1;
    const isComplete = nextIndex >= questions.length;
    if (isComplete) {
      await db.completePulseResponse(response.id);
      await db.deletePulseState(campaignId, userId);
      const respondedAt = new Date().toISOString();
      notion.createPulseResponseRow({ campaignId, respondentName: response.slack_display_name, slackId: userId, respondedAt, pulseTitle: campaign.title })
        .then(async (responsePageId) => {
          if (responsePageId) {
            await db.updatePulseResponseNotionId(response.id, responsePageId);
            await notion.updatePulseResponseAnswers({ responsePageId, answers });
          }
          if (campaign.notion_campaign_page_id) {
            const { rows: completedRows } = await db.countCompletedPulseResponses(campaignId);
            const count = completedRows?.[0]?.count ? parseInt(completedRows[0].count) : 1;
            await notion.updatePulseCampaignRespondentCount({ campaignPageId: campaign.notion_campaign_page_id, respondentCount: count });
          }
        }).catch(err => logger.warn('Notion pulse response sync failed:', err.message));
      const completionBlocks = [
        { type: 'header', text: { type: 'plain_text', text: '🎉 All done!', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Thanks for completing *"${campaign.title}"*! Your responses have been recorded. 🙏` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${buildPulseProgressBar(questions.length, questions.length)} ${questions.length}/${questions.length} questions answered` }] },
      ];
      if (state.dm_channel && state.dm_ts) {
        try { await client.chat.update({ channel: state.dm_channel, ts: state.dm_ts, text: `🎉 Thanks for completing "${campaign.title}"!`, blocks: completionBlocks }); }
        catch (err) { logger.warn('Could not update pulse DM on completion:', err.message); }
      } else {
        try { await client.chat.postMessage({ channel: userId, text: `🎉 Thanks for completing "${campaign.title}"!`, blocks: completionBlocks }); }
        catch (err) { logger.warn('Could not send completion DM:', err.message); }
      }
    } else {
      await db.updatePulseStateQuestion(campaignId, userId, nextIndex);
      const nextBlocks = buildPulseDMBlocks(campaign, nextIndex, null);
      if (state.dm_channel && state.dm_ts) {
        try { await client.chat.update({ channel: state.dm_channel, ts: state.dm_ts, text: `📊 ${campaign.title} — question ${nextIndex + 1} of ${questions.length}`, blocks: nextBlocks }); }
        catch (err) { logger.warn('Could not update pulse DM for next question:', err.message); }
      } else {
        try {
          const dmResult = await client.chat.postMessage({ channel: userId, text: `📊 ${campaign.title} — question ${nextIndex + 1} of ${questions.length}`, blocks: nextBlocks });
          if (dmResult?.ts) await db.createPulseState({ id: randomUUID(), campaign_id: campaignId, slack_user_id: userId, dm_ts: dmResult.ts, dm_channel: dmResult.channel });
        } catch (err) { logger.warn('Could not send next question DM:', err.message); }
      }
    }
  } catch (err) { logger.error('handlePulseAnswer error:', err); }
}
// ============================================================
//  Pulse DM block builder
// ============================================================
function buildPulseDMBlocks(campaign, questionIndex, _currentAnswer) {
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
function buildPulseProgressBar(current, total) {
  if (total === 0) return '';
  const filled = Math.min(current, total);
  const empty = total - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}
// ============================================================
//  Pulse audience resolver
// ============================================================
async function resolvePulseAudience(client, groupValues, selectedChannels, individualUsers, senderId, includeChannelMembers, logger) {
  let userIds = [];
  const groupNameParts = [];
  let targetType = 'manual';
  let targetRaw = '';
  const channelPostTargets = [];
  for (const gv of groupValues) {
    try {
      if (gv.startsWith('slack_ug:')) {
        const [, ugId, ugName] = gv.split(':');
        groupNameParts.push(ugName);
        targetType = 'usergroup';
        targetRaw = gv;
        const membersRes = await client.usergroups.users.list({ usergroup: ugId });
        userIds = userIds.concat(membersRes.users || []);
      }
    } catch (err) { logger.error('Error resolving pulse user group:', err); }
  }
  for (const channelId of selectedChannels) {
    try {
      const chanInfo = await client.conversations.info({ channel: channelId });
      const chanName = chanInfo.channel?.name || channelId;
      groupNameParts.push(`#${chanName}`);
      channelPostTargets.push({ id: channelId, name: chanName });
      targetType = 'channel';
      targetRaw = `channel:${channelId}:${chanName}`;
      if (includeChannelMembers) {
        const members = await listAllChannelMembers(client, channelId, logger);
        userIds = userIds.concat(members.filter((id) => id !== senderId));
      }
    } catch (err) { logger.error('Error resolving pulse channel:', err); }
  }
  if (individualUsers.length > 0) {
    if (!targetRaw) targetRaw = 'individuals';
    if (groupNameParts.length === 0) targetType = 'manual';
  }
  const allUserIds = [...new Set([...userIds, ...individualUsers])];
  let groupName;
  if (groupNameParts.length > 0) {
    groupName = groupNameParts.join(' + ');
    if (individualUsers.length > 0) groupName += ` + ${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  } else if (individualUsers.length > 0) {
    groupName = `${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  } else {
    groupName = 'Unknown Group';
  }
  return { userIds: allUserIds, groupName, targetType, targetRaw, channelPostTargets };
}
// ============================================================
//  Shared helper: build pulse picker modal options
// ============================================================
async function buildPulsePickerOptions(senderId) {
  const campaigns = await db.getRecentPulseCampaigns(senderId, 10);
  return campaigns.map(c => {
    const d = new Date(c.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return {
      text: { type: 'plain_text', text: `${c.title} — ${d}`, emoji: true },
      value: c.id,
    };
  });
}
// ============================================================
//  /radarpulse-results — modal picker → DM breakdown
// ============================================================
app.command('/radarpulse-results', async ({ ack, body, client, logger }) => {
  await ack();
  const options = await buildPulsePickerOptions(body.user_id);
  if (options.length === 0) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { type: 'modal', title: { type: 'plain_text', text: 'No Pulses Found' }, close: { type: 'plain_text', text: 'Close' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: "You haven't sent any pulses yet. Use `/radarpulse` to send your first one." } }] },
    });
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'pulse_results_modal_submit',
      title: { type: 'plain_text', text: '📊 View Pulse Results', emoji: true },
      submit: { type: 'plain_text', text: 'View Results →', emoji: true },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [{
        type: 'input',
        block_id: 'pulse_pick_block',
        label: { type: 'plain_text', text: 'Select a pulse', emoji: true },
        element: { type: 'static_select', action_id: 'pulse_pick_input', placeholder: { type: 'plain_text', text: 'Choose one...' }, options },
      }],
    },
  });
});
app.view('pulse_results_modal_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const campaignId = view.state.values.pulse_pick_block.pulse_pick_input.selected_option?.value;
  if (!campaignId) return;
  try {
    const campaign = await db.getPulseCampaign(campaignId);
    if (!campaign) { await client.chat.postMessage({ channel: userId, text: '❌ Pulse not found.' }); return; }
    const allResponses = await db.getAllPulseResponses(campaignId);
    const completed = allResponses.filter(r => r.completed_at);
    const resultBlocks = buildPulseResultsBlocks(campaign, completed);
    for (let i = 0; i < resultBlocks.length; i += 45) {
      await client.chat.postMessage({ channel: userId, blocks: resultBlocks.slice(i, i + 45), text: `Results: "${campaign.title}"` });
    }
  } catch (err) { logger.error('pulse_results_modal_submit error:', err); }
});
// ============================================================
//  /radarpulse-export — modal picker → DM CSV file
// ============================================================
app.command('/radarpulse-export', async ({ ack, body, client, logger }) => {
  await ack();
  const options = await buildPulsePickerOptions(body.user_id);
  if (options.length === 0) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { type: 'modal', title: { type: 'plain_text', text: 'No Pulses Found' }, close: { type: 'plain_text', text: 'Close' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: "You haven't sent any pulses yet. Use `/radarpulse` to send your first one." } }] },
    });
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'pulse_export_modal_submit',
      title: { type: 'plain_text', text: '⬇️ Export Pulse CSV', emoji: true },
      submit: { type: 'plain_text', text: 'Export CSV →', emoji: true },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [{
        type: 'input',
        block_id: 'pulse_pick_block',
        label: { type: 'plain_text', text: 'Select a pulse', emoji: true },
        element: { type: 'static_select', action_id: 'pulse_pick_input', placeholder: { type: 'plain_text', text: 'Choose one...' }, options },
      }],
    },
  });
});
app.view('pulse_export_modal_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const campaignId = view.state.values.pulse_pick_block.pulse_pick_input.selected_option?.value;
  if (!campaignId) return;
  try {
    const campaign = await db.getPulseCampaign(campaignId);
    if (!campaign) { await client.chat.postMessage({ channel: userId, text: '❌ Pulse not found.' }); return; }
    const allResponses = await db.getAllPulseResponses(campaignId);
    const completed = allResponses.filter(r => r.completed_at);
    if (completed.length === 0) {
      await client.chat.postMessage({ channel: userId, text: `ℹ️ No completed responses yet for *"${campaign.title}"*.` });
      return;
    }
    const csv = buildPulseCSV(campaign, completed);
    const safeTitle = campaign.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await client.files.uploadV2({
      channel_id: userId,
      filename: `pulse-${safeTitle}.csv`,
      content: csv,
      title: campaign.title,
      initial_comment: `📊 *${campaign.title}* — ${completed.length} response${completed.length !== 1 ? 's' : ''} exported`,
    });
  } catch (err) { logger.error('pulse_export_modal_submit error:', err); }
});
// ============================================================
//  /radarping-review — view & cancel pending scheduled posts
// ============================================================
function formatScheduledPostBlocks(posts) {
  if (posts.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: '_No pending scheduled posts._\n\nUse `/radarping` or `/radarpulse` to schedule one.' } }];
  }
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `You have *${posts.length}* pending scheduled post${posts.length !== 1 ? 's' : ''}.` } },
    { type: 'divider' },
  ];
  for (const p of posts) {
    const payload = typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload;
    const typeLabel = p.type === 'pulse' ? '📊 Pulse' : '📣 Announce';
    const title = payload.title || (payload.message ? payload.message.slice(0, 80) : 'Untitled');
    const audienceParts = [];
    if (payload.channels?.length) audienceParts.push(`${payload.channels.length} channel${payload.channels.length !== 1 ? 's' : ''}`);
    if (payload.usergroupIds?.length) audienceParts.push(`${payload.usergroupIds.length} group${payload.usergroupIds.length !== 1 ? 's' : ''}`);
    if (payload.individualUsers?.length) audienceParts.push(`${payload.individualUsers.length} individual${payload.individualUsers.length !== 1 ? 's' : ''}`);
    const audience = audienceParts.join(' + ') || 'no audience';
    const whenMrkdwn = `<!date^${p.scheduled_at}^{date_short_pretty} at {time}|scheduled>`;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${typeLabel}* — ${title}\n⏰ ${whenMrkdwn}\n👥 ${audience}` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel', emoji: true },
        style: 'danger',
        action_id: 'review_cancel_post',
        value: String(p.id),
        confirm: {
          title: { type: 'plain_text', text: 'Cancel this post?' },
          text: { type: 'mrkdwn', text: `*${title}*\n\nThis cannot be undone — but you can re-schedule a fresh one.` },
          confirm: { type: 'plain_text', text: 'Cancel it' },
          deny: { type: 'plain_text', text: 'Keep it' },
        },
      },
    });
    blocks.push({ type: 'divider' });
  }
  return blocks;
}
async function buildReviewModal(senderId) {
  const all = await db.getScheduledPostsByUser({ user_id: senderId });
  const now = Math.floor(Date.now() / 1000);
  const pending = all.filter(p => p.status === 'pending' && p.scheduled_at > now);
  return {
    type: 'modal',
    callback_id: 'radarping_review_modal',
    title: { type: 'plain_text', text: '📋 Scheduled Posts', emoji: true },
    close: { type: 'plain_text', text: 'Close' },
    blocks: formatScheduledPostBlocks(pending),
  };
}
app.command('/radarping-review', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const view = await buildReviewModal(body.user_id);
    await client.views.open({ trigger_id: body.trigger_id, view });
  } catch (err) {
    logger.error('radarping-review error:', err);
    await client.chat.postMessage({ channel: body.user_id, text: `❌ Could not load scheduled posts: ${err.message}` });
  }
});
app.action('review_cancel_post', async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    const postId = parseInt(action.value, 10);
    const senderId = body.user.id;
    // Verify ownership before cancelling
    const all = await db.getScheduledPostsByUser({ user_id: senderId });
    const target = all.find(p => p.id === postId);
    if (!target) {
      await client.chat.postMessage({ channel: senderId, text: `❌ That post wasn't found or isn't yours.` });
      return;
    }
    if (target.status !== 'pending') {
      await client.chat.postMessage({ channel: senderId, text: `⚠️ That post is already *${target.status}* — too late to cancel.` });
      return;
    }
    await db.cancelScheduledPost({ id: postId });
    // Refresh the modal in place
    const updated = await buildReviewModal(senderId);
    await client.views.update({ view_id: body.view.id, view: updated });
    await client.chat.postMessage({ channel: senderId, text: `✅ Cancelled scheduled post.` });
  } catch (err) {
    logger.error('review_cancel_post error:', err);
  }
});
// ============================================================
//  buildPulseCSV — generates CSV string for a campaign
// ============================================================
function csvEscape(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
function buildPulseCSV(campaign, completedResponses) {
  const questions = campaign.questions;
  const headers = [
    'Respondent',
    'Slack ID',
    'Responded At',
    ...questions.map(q => `Q${q.index + 1}: ${q.text}`),
  ];
  const rows = [headers.map(csvEscape).join(',')];
  for (const response of completedResponses) {
    const respondedAt = response.completed_at
      ? new Date(response.completed_at * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
      : '';
    const cols = [
      response.slack_display_name || response.slack_user_id,
      response.slack_user_id,
      respondedAt,
      ...questions.map(q => {
        const answer = response.answers[q.index];
        if (!answer) return '';
        if (q.response_type === 'scale_10' || q.response_type === 'scale_5') return answer.score ?? '';
        return answer.answer ?? '';
      }),
    ];
    rows.push(cols.map(csvEscape).join(','));
  }
  return rows.join('\n');
}
// ============================================================
//  buildPulseResultsBlocks — formats full results for one campaign
// ============================================================
function buildPulseResultsBlocks(campaign, completedResponses) {
  const totalSent = campaign.resolved_users?.length || 0;
  const responded = completedResponses.length;
  const pct = totalSent > 0 ? Math.round((responded / totalSent) * 100) : 0;
  const sentDate = new Date(campaign.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${campaign.title}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Sent *${sentDate}* · *${responded}* of *${totalSent}* responded *(${pct}%)*` } },
    { type: 'divider' },
  ];
  for (const question of campaign.questions) {
    const qi = question.index;
    const answersForQ = completedResponses.map(r => r.answers[qi]).filter(a => a != null);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Q${qi + 1}: ${question.text}*` } });
    if (answersForQ.length === 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_No responses yet_' }] });
    } else if (question.response_type === 'scale_10' || question.response_type === 'scale_5') {
      const scores = answersForQ.map(a => a.score).filter(s => s != null);
      const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      const max = question.response_type === 'scale_10' ? 10 : 5;
      const dist = {};
      for (let n = 1; n <= max; n++) dist[n] = 0;
      scores.forEach(s => { if (dist[s] !== undefined) dist[s]++; });
      const distText = Object.entries(dist).map(([n, c]) => `${n}▸${c}`).join('  ');
      const lowHigh = (question.low_label || question.high_label) ? `\n_${question.low_label || ''}_ → _${question.high_label || ''}_` : '';
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `avg *${avg}* · ${scores.length} response${scores.length !== 1 ? 's' : ''}${lowHigh}\n\`${distText}\`` }] });
    } else if (question.response_type === 'multi_select') {
      const choices = question.choices || [];
      const counts = {};
      choices.forEach(c => { counts[c] = 0; });
      answersForQ.forEach(a => {
        const ans = String(a.answer || '');
        counts[ans] = (counts[ans] || 0) + 1;
      });
      const lines = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([choice, count]) => {
        const p = Math.round((count / answersForQ.length) * 100);
        const bar = '█'.repeat(Math.round(p / 10)) + '░'.repeat(10 - Math.round(p / 10));
        return `${bar} *${choice}*: ${count} (${p}%)`;
      });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 3000) } });
    } else {
      // free_text
      const texts = answersForQ.map(a => String(a.answer || '')).filter(Boolean);
      const MAX_SHOW = 15;
      const shown = texts.slice(0, MAX_SHOW).map(t => `• ${t.slice(0, 300)}`).join('\n');
      const overflow = texts.length > MAX_SHOW ? `\n_…and ${texts.length - MAX_SHOW} more_` : '';
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: (shown + overflow).slice(0, 3000) } });
    }
    blocks.push({ type: 'divider' });
  }
  return blocks;
}
// ============================================================
//  Start
// ============================================================
(async () => {
  await app.start();
  startScheduleWorker(app);
  console.log(`\n✅ Radar Ping is running!`);
  console.log(`   Slack Socket Mode: ${process.env.SLACK_APP_TOKEN ? 'enabled' : 'disabled (using HTTP)'}`);
  console.log(`   Port: ${process.env.PORT || 3456}\n`);
  console.log(`   Commands available:`);
  console.log(`     /announce          - Send a tracked announcement`);
  console.log(`     /radarping         - Alias for /announce`);
  console.log(`     /announce-status   - View read receipts`);
  console.log(`     /radarpulse         - Send a pulse quiz`);
  console.log(`     /radarpulse-results - View pulse response summaries`);
  console.log(`     /radarpulse-export  - Export pulse responses as CSV`);
  console.log(`     /radarping-review   - View & cancel pending scheduled posts\n`);
})();
