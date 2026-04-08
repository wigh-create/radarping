/**
 * Announce Bot - Tracked Slack Broadcasts with Read Receipts
 *
 * Commands:
 *   /announce        - Compose and send an announcement to groups
 *   /announce-status - Check read receipts for your announcements
 */
require('dotenv').config();
const { App } = require('@slack/bolt');
const { randomUUID } = require('crypto');
const db = require('./db');
const notion = require('./notion');

// FIX: In-memory cache for pulse modal options.
// Slack hard-limits private_metadata to 3000 chars — storing allOptions (up to 99 entries)
// blows past that. We cache options server-side and store only a short session ID instead.
const pulseModalCache = new Map();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: process.env.SLACK_APP_TOKEN ? true : false,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3456,
});
// ============================================================
//  Shared helper: open the announce modal (used by /announce and message shortcut)
// ============================================================
async function openAnnounceModal({ client, triggerId, prefillMessage = '', logger }) {
  try {
    let ugOptions = [];
    try {
      const ugRes = await client.usergroups.list({ include_disabled: false });
      ugOptions = (ugRes.usergroups || []).map(ug => ({
        text: { type: 'plain_text', text: `${ug.name} (${ug.handle})`, emoji: true },
        value: `slack_ug:${ug.id}:${ug.name}`,
      }));
    } catch (e) {
      logger.warn('Could not fetch Slack usergroups:', e.message);
    }
    let channelOptions = [];
    try {
      const chanRes = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200, exclude_archived: true });
      const botChannels = (chanRes.channels || []).filter(c => c.is_member);
      channelOptions = botChannels.slice(0, 50).map(c => ({
        text: { type: 'plain_text', text: `#${c.name}`, emoji: true },
        value: `channel:${c.id}:${c.name}`,
      }));
    } catch (e) {
      logger.warn('Could not fetch channels:', e.message);
    }
    // Slack multi_static_select hard limit is 100 options total.
    // Priority: ALL Slack usergroups first (no cap), then channels fill remaining slots.
    const remainingSlots = Math.max(0, 100 - ugOptions.length);
    const allOptions = [...ugOptions, ...channelOptions.slice(0, remainingSlots)].slice(0, 100);
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
    ];
    if (allOptions.length > 0) {
      blocks.push({
        type: 'input',
        block_id: 'audience_block',
        optional: true,
        element: {
          type: 'multi_static_select',
          action_id: 'audience_select',
          placeholder: { type: 'plain_text', text: 'Choose groups or channels (optional)...' },
          options: allOptions,
        },
        label: { type: 'plain_text', text: '👥 Send to groups / channels', emoji: true },
        hint: { type: 'plain_text', text: 'Optional — select one or more groups/channels, or skip to send to individuals only' },
      });
    }
    blocks.push(
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
        block_id: 'individual_block',
        optional: true,
        element: {
          type: 'multi_users_select',
          action_id: 'individual_users',
          placeholder: { type: 'plain_text', text: 'Add specific people (optional)' },
        },
        label: { type: 'plain_text', text: '🙋 Also send to individuals', emoji: true },
        hint: { type: 'plain_text', text: 'Optional: send to specific people on top of the group above' },
      },
      {
        type: 'input',
        block_id: 'also_post_block',
        optional: true,
        element: {
          type: 'conversations_select',
          action_id: 'also_post_channel',
          placeholder: { type: 'plain_text', text: 'Also post in a channel (optional)' },
          filter: { include: ['public', 'private'] },
        },
        label: { type: 'plain_text', text: '📢 Also post in channel', emoji: true },
        hint: { type: 'plain_text', text: 'Optional: post publicly in a channel the bot has been invited to' },
      }
    );
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
  // Extract plain text from the message (strip any Slack mrkdwn if needed)
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
//  Modal submit - send the announcement
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
  const audienceValues = values.audience_block?.audience_select?.selected_options?.map(o => o.value) || [];
  const alsoPostChannel = values.also_post_block?.also_post_channel?.selected_conversation;
  const individualUsers = values.individual_block?.individual_users?.selected_users || [];
  const hasAudience = audienceValues.length > 0 || individualUsers.length > 0 || alsoPostChannel;
  if (!hasAudience) {
    await client.chat.postMessage({
      channel: senderId,
      text: '❌ No audience selected. Pick a group, add individuals, or choose a channel to post in.',
    });
    return;
  }
  // Resolve each selected audience to a list of user IDs
  let userIds = [];
  const groupNameParts = [];
  let targetType = 'manual';
  let targetId = null;
  // Track whether the selection is channel-only (no groups, no individuals)
  let selectedChannelNames = [];
  let hasNonChannelAudience = false;
  for (const audienceValue of audienceValues) {
    try {
      if (audienceValue.startsWith('slack_ug:')) {
        // Slack User Group
        const [, ugId, ugName] = audienceValue.split(':');
        groupNameParts.push(ugName);
        targetType = 'usergroup';
        targetId = ugId;
        hasNonChannelAudience = true;
        const membersRes = await client.usergroups.users.list({ usergroup: ugId });
        userIds = userIds.concat(membersRes.users || []);
      } else if (audienceValue.startsWith('channel:')) {
        // Channel — get members and require read receipts from all of them
        const [, channelId, chanName] = audienceValue.split(':');
        groupNameParts.push(`#${chanName}`);
        selectedChannelNames.push(chanName);
        targetType = 'channel';
        targetId = channelId;
        const membersRes = await client.conversations.members({ channel: channelId });
        userIds = userIds.concat((membersRes.members || []).filter(id => id !== senderId));
      }
    } catch (err) {
      logger.error('Error resolving audience:', err);
    }
  }
  // Merge in any individually selected users (deduplicated)
  if (individualUsers.length > 0) {
    hasNonChannelAudience = true;
  }
  const allUserIds = [...new Set([...userIds, ...individualUsers])];
  // Build a composite group name
  let groupName;
  if (groupNameParts.length > 0) {
    groupName = groupNameParts.join(' + ');
    if (individualUsers.length > 0) {
      groupName += ` + ${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
    }
  } else if (individualUsers.length > 0) {
    groupName = `${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  } else {
    groupName = 'Unknown Group';
  }
  // Determine if this is a channel-only announcement (no groups, no individuals)
  const isChannelOnly = selectedChannelNames.length > 0 && !hasNonChannelAudience;
  if (allUserIds.length === 0 && !alsoPostChannel) {
    await client.chat.postMessage({
      channel: senderId,
      text: `❌ Couldn't resolve any recipients. Check the group has members, add individuals, or pick a channel to post in.`,
    });
    return;
  }
  userIds = allUserIds;
  const announcementId = randomUUID();
  await db.createAnnouncement({
    id: announcementId,
    sender_id: senderId,
    sender_name: senderName,
    message,
    group_name: groupName,
    target_type: targetType,
    target_id: targetId,
  });
  // Fetch user names
  const recipientUsers = [];
  for (const uid of userIds) {
    try {
      const info = await client.users.info({ user: uid });
      const u = info.user;
      // Skip bots, deactivated users, the sender themselves
      if (u.is_bot || u.deleted || u.id === senderId) continue;
      recipientUsers.push({ user_id: u.id, user_name: u.profile?.real_name || u.profile?.display_name || u.name });
    } catch {
      recipientUsers.push({ user_id: uid, user_name: uid });
    }
  }
  await db.addRecipients(announcementId, recipientUsers);
  await db.updateRecipientCount(announcementId, recipientUsers.length);
  // Sync to Notion — create announcement row, then one row per recipient
  const sentAt = new Date().toISOString();
  notion.createAnnouncementPage({
    announcementId, title, message, senderName, groupName,
    totalRecipients: recipientUsers.length, linkUrl, sentAt,
  }).then(announcementPageId => {
    if (announcementPageId && recipientUsers.length > 0) {
      notion.createRecipientRows({ announcementPageId, recipients: recipientUsers, sentAt });
    }
  });
  // Send DM to each recipient with read button
  let sent = 0;
  for (const recipient of recipientUsers) {
    try {
      const dmResult = await client.chat.postMessage({
        channel: recipient.user_id,
        text: `📣 Announcement from <@${senderId}>: ${message}`,
        blocks: buildAnnouncementBlocks(title, message, senderId, announcementId, groupName, linkUrl),
      });
      // Store ts so we can update the DM when they read from any location
      if (dmResult?.ts) {
        await db.storeDmTs(announcementId, recipient.user_id, dmResult.ts, dmResult.channel);
      }
      sent++;
    } catch (err) {
      logger.warn(`Could not DM ${recipient.user_id}:`, err.message);
    }
  }
  // Also post in a channel if requested
  if (alsoPostChannel) {
    try {
      // Auto-join the channel if not already a member
      try { await client.conversations.join({ channel: alsoPostChannel }); } catch {}
      await client.chat.postMessage({
        channel: alsoPostChannel,
        text: `📣 Announcement from <@${senderId}>: ${message}`,
        blocks: buildAnnouncementBlocks(title, message, senderId, announcementId, groupName, linkUrl),
      });
    } catch (err) {
      logger.warn('Could not post to channel:', err.message);
    }
  }
  // Confirm to sender
  const confirmBlocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `✅ *Announcement sent!*\n📣 *"${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"*\n\n👥 Sent to *${groupName}* — *${sent}/${recipientUsers.length}* DMs delivered.` },
    },
  ];
  if (isChannelOnly) {
    const channelList = selectedChannelNames.map(n => `#${n}`).join(', ');
    confirmBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ *All members of ${channelList} will need to confirm they've read this announcement.* Read receipts are being tracked for every channel member.` },
    });
  }
  confirmBlocks.push(
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Track read receipts with:\n\`/announce-status ${announcementId.slice(0, 8)}\`` },
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📊 Check Read Receipts', emoji: true },
        action_id: 'check_status',
        value: announcementId,
        style: 'primary',
      }],
    }
  );
  await client.chat.postMessage({
    channel: senderId,
    text: `✅ Announcement sent to *${groupName}*`,
    blocks: confirmBlocks,
  });
});
// ============================================================
//  Read receipt button click
// ============================================================
app.action('mark_as_read', async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  const announcementId = action.value;
  // Auto-add the user as a recipient if they clicked from a channel post (wasn't in the original list)
  let userName = body.user.name || userId;
  try {
    const info = await client.users.info({ user: userId });
    userName = info.user?.profile?.real_name || info.user?.profile?.display_name || info.user?.name || userId;
  } catch {}
  await db.addRecipients(announcementId, [{ user_id: userId, user_name: userName }]);
  const alreadyRead = (await db.getRecipient(announcementId, userId))?.read_at;
  await db.markRead(announcementId, userId);
  // Only notify sender + sync Notion on first read (not if they somehow click twice)
  if (!alreadyRead) {
    const stats = await db.getRecipientStats(announcementId);
    notion.markRecipientRead({ announcementId, userId, userName });
    notion.updateReadStats({
      announcementId,
      readCount: stats.read_count,
      pendingCount: stats.total - stats.read_count,
      totalRecipients: stats.total,
    });
  }
  const readBlocks = (originalBlocks) => [
    ...originalBlocks.slice(0, -1),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `✅ *You confirmed reading this* at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|just now>`,
      }],
    },
  ];

  // FIX: Channel posts are shared — if clicked from a channel, do NOT update the channel
  // message (that would remove the button for everyone). Instead update only their DM
  // and send an ephemeral ack in the channel.
  const clickedInChannel = body.channel?.id && !body.channel.id.startsWith('D');

  if (clickedInChannel) {
    // Send an ephemeral "got it" only visible to this user — channel post stays intact
    try {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: userId,
        text: `✅ Got it — marked as read.`,
      });
    } catch (err) {
      logger.warn('Could not send ephemeral read confirmation:', err.message);
    }
    // Update their DM if one exists
    try {
      const recipientInfo = await db.getRecipient(announcementId, userId);
      if (recipientInfo?.dm_ts && recipientInfo.dm_channel) {
        const dmMsg = await client.conversations.history({
          channel: recipientInfo.dm_channel,
          latest: recipientInfo.dm_ts,
          limit: 1,
          inclusive: true,
        });
        const dmBlocks = dmMsg?.messages?.[0]?.blocks;
        if (dmBlocks) {
          await client.chat.update({
            channel: recipientInfo.dm_channel,
            ts: recipientInfo.dm_ts,
            text: '✅ You\'ve confirmed you\'ve read this announcement.',
            blocks: readBlocks(dmBlocks),
          });
        }
      }
    } catch (err) {
      logger.warn('Could not update DM after channel read:', err.message);
    }
  } else {
    // Clicked from DM — update the DM in place (original behaviour)
    try {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: '✅ You\'ve confirmed you\'ve read this announcement.',
        blocks: readBlocks(body.message.blocks),
      });
    } catch (err) {
      logger.warn('Could not update DM on read:', err.message);
    }
  }
  // Notify the sender of the read
  try {
    const announcement = await db.getAnnouncement(announcementId);
    const stats = await db.getRecipientStats(announcementId);
    if (announcement) {
      await client.chat.postMessage({
        channel: announcement.sender_id,
        text: `👁️ <@${userId}> just read your announcement`,
        blocks: [{
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `👁️ <@${userId}> marked your announcement as read. *${stats.read_count}/${stats.total}* have now read it.`,
          }],
        }],
      });
    }
  } catch (err) {
    logger.warn('Could not notify sender:', err.message);
  }
});
// ============================================================
//  Check status button (from sender confirmation message)
// ============================================================
app.action('check_status', async ({ ack, body, action, client, logger }) => {
  await ack();
  const announcementId = action.value;
  await sendStatusReport(client, body.user.id, announcementId, logger);
});
// ============================================================
//  /announce-status - View read receipt dashboard
// ============================================================
app.command('/announce-status', async ({ ack, body, client, logger }) => {
  await ack();
  const senderId = body.user.id;
  const args = (body.text || '').trim();
  if (args) {
    // Look up a specific announcement by short ID prefix
    const recent = await db.getRecentAnnouncements(senderId, 20);
    const match = recent.find(a => a.id.startsWith(args) || a.id === args);
    if (match) {
      await sendStatusReport(client, senderId, match.id, logger);
    } else {
      await client.chat.postMessage({
        channel: senderId,
        text: `❌ No announcement found matching \`${args}\`. Try \`/announce-status\` (no args) to see your recent announcements.`,
      });
    }
  } else {
    // Show list of recent announcements
    const recent = await db.getRecentAnnouncements(senderId, 10);
    if (recent.length === 0) {
      await client.chat.postMessage({
        channel: senderId,
        text: '📭 You haven\'t sent any announcements yet. Use `/announce` to send one!',
      });
      return;
    }
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📣 Your Recent Announcements', emoji: true },
      },
      { type: 'divider' },
    ];
    for (const ann of recent) {
      const stats = await db.getRecipientStats(ann.id);
      const pct = stats.total > 0 ? Math.round((stats.read_count / stats.total) * 100) : 0;
      const bar = buildProgressBar(pct);
      const date = new Date(ann.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*"${ann.message.slice(0, 80)}${ann.message.length > 80 ? '...' : ''}"*\n👥 *${ann.group_name}* · 📅 ${date}\n${bar} *${stats.read_count}/${stats.total}* read (${pct}%)`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '📊 Details', emoji: true },
          action_id: 'check_status',
          value: ann.id,
        },
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
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📣 ${title}`, emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Sent by <@${senderId}>` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        linkUrl
          ? {
              // Link button: opens URL AND fires mark_as_read action simultaneously
              type: 'button',
              text: { type: 'plain_text', text: '📖 Open to Read', emoji: true },
              action_id: 'mark_as_read',
              value: announcementId,
              url: linkUrl,
              style: 'primary',
            }
          : {
              // No link: standard read confirmation with confirm dialog
              type: 'button',
              text: { type: 'plain_text', text: '✅ Mark as Read', emoji: true },
              action_id: 'mark_as_read',
              value: announcementId,
              style: 'primary',
              confirm: {
                title: { type: 'plain_text', text: 'Confirm you\'ve read this' },
                text: { type: 'plain_text', text: 'This will notify the sender that you\'ve read the announcement.' },
                confirm: { type: 'plain_text', text: 'Yes, I\'ve read it' },
                deny: { type: 'plain_text', text: 'Cancel' },
              },
            },
      ],
    },
  ];
  return blocks;
}
async function sendStatusReport(client, requesterId, announcementId, logger) {
  const announcement = await db.getAnnouncement(announcementId);
  if (!announcement) {
    await client.chat.postMessage({ channel: requesterId, text: '❌ Announcement not found.' });
    return;
  }
  const stats = await db.getRecipientStats(announcementId);
  const pending = await db.getPendingReaders(announcementId);
  const all = await db.getAllReaders(announcementId);
  const pct = stats.total > 0 ? Math.round((stats.read_count / stats.total) * 100) : 0;
  const bar = buildProgressBar(pct);
  const date = new Date(announcement.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const readList = all
    .filter(r => r.read_at)
    .map(r => `✅ <@${r.user_id}>`)
    .join('  ');
  const pendingList = pending
    .slice(0, 20)
    .map(r => `⏳ <@${r.user_id}>`)
    .join('  ');
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 Read Receipt Report', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*"${announcement.message.slice(0, 120)}${announcement.message.length > 120 ? '...' : ''}"*\n📅 Sent ${date} to *${announcement.group_name}*`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${bar}  *${stats.read_count}/${stats.total}* have read this (${pct}%)`,
      },
    },
  ];
  if (readList) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*✅ Read (${stats.read_count}):*\n${readList || '_none yet_'}` },
    });
  }
  if (pendingList) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*⏳ Not yet read (${pending.length}):*\n${pendingList}${pending.length > 20 ? `\n_...and ${pending.length - 20} more_` : ''}` },
    });
    // Nudge button for non-readers
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '👋 Nudge Unread People', emoji: true },
        action_id: 'nudge_unread',
        value: announcementId,
        style: 'danger',
      }],
    });
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
  if (!announcement || pending.length === 0) {
    await client.chat.postMessage({ channel: body.user.id, text: '✅ Everyone has read it already!' });
    return;
  }
  let nudged = 0;
  for (const recipient of pending) {
    try {
      await client.chat.postMessage({
        channel: recipient.user_id,
        text: `👋 Reminder from <@${announcement.sender_id}>: you haven\'t marked this announcement as read yet.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `👋 *Reminder:* <@${announcement.sender_id}> is waiting for your read confirmation on this announcement:\n\n_"${announcement.message.slice(0, 200)}${announcement.message.length > 200 ? '...' : ''}"_`,
            },
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: '✅ Mark as Read', emoji: true },
              action_id: 'mark_as_read',
              value: announcementId,
              style: 'primary',
            }],
          },
        ],
      });
      nudged++;
    } catch (err) {
      logger.warn(`Could not nudge ${recipient.user_id}:`, err.message);
    }
  }
  await client.chat.postMessage({
    channel: body.user.id,
    text: `👋 Nudged ${nudged} people who haven't read it yet.`,
  });
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
async function openPulseModal({ client, triggerId, logger }) {
  try {
    let ugOptions = [];
    try {
      const ugRes = await client.usergroups.list({ include_disabled: false });
      ugOptions = (ugRes.usergroups || []).map(ug => ({
        text: { type: 'plain_text', text: `${ug.name} (${ug.handle})`, emoji: true },
        value: `slack_ug:${ug.id}:${ug.name}`,
      }));
    } catch (e) {
      logger.warn('Could not fetch Slack usergroups:', e.message);
    }
    let channelOptions = [];
    try {
      const chanRes = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200, exclude_archived: true });
      const botChannels = (chanRes.channels || []).filter(c => c.is_member);
      channelOptions = botChannels.slice(0, 50).map(c => ({
        text: { type: 'plain_text', text: `#${c.name}`, emoji: true },
        value: `channel:${c.id}:${c.name}`,
      }));
    } catch (e) {
      logger.warn('Could not fetch channels:', e.message);
    }
    // Slack multi_static_select hard limit is 100 options total.
    // Priority: ALL Slack usergroups first (no cap), then channels fill remaining slots.
    const remainingSlots = Math.max(0, 100 - ugOptions.length);
    const allOptions = [...ugOptions, ...channelOptions.slice(0, remainingSlots)].slice(0, 100);

    // FIX: Store options in server-side cache, put only a short session ID in private_metadata.
    // Slack's private_metadata limit is 3000 chars — allOptions easily exceeds that.
    const sessionId = randomUUID();
    pulseModalCache.set(sessionId, { allOptions });
    setTimeout(() => pulseModalCache.delete(sessionId), 60 * 60 * 1000); // auto-clean after 1hr

    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'pulse_modal_submit',
        title: { type: 'plain_text', text: '📊 Send Pulse', emoji: true },
        submit: { type: 'plain_text', text: 'Send Pulse →', emoji: true },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: buildPulseModalBlocks(allOptions),
        private_metadata: JSON.stringify({ sessionId }),
      },
    });
  } catch (error) {
    logger.error('Error opening pulse modal:', error);
  }
}
// ------------------------------------------------------------
//  buildPulseModalBlocks — dynamic growth version
//  questionsVisible: how many question slots to render (1–5)
//  visibleLabelBlocks: Set of block_ids that should show label fields
// ------------------------------------------------------------
function buildPulseModalBlocks(allOptions, questionsVisible = 1, visibleLabelBlocks = new Set()) {
  const blocks = [
    {
      type: 'input',
      block_id: 'pulse_title_block',
      element: {
        type: 'plain_text_input',
        action_id: 'pulse_title_input',
        placeholder: { type: 'plain_text', text: 'e.g. Q1 Team Health Check, Sprint Retro Pulse...' },
        max_length: 80,
      },
      label: { type: 'plain_text', text: '📌 Pulse Title', emoji: true },
    },
  ];
  if (allOptions.length > 0) {
    blocks.push({
      type: 'input',
      block_id: 'pulse_audience_block',
      optional: true,
      element: {
        type: 'multi_static_select',
        action_id: 'pulse_audience_select',
        placeholder: { type: 'plain_text', text: 'Choose groups or channels...' },
        options: allOptions,
      },
      label: { type: 'plain_text', text: '👥 Send to', emoji: true },
      hint: { type: 'plain_text', text: 'Select one or more groups/channels, or add individuals below' },
    });
  }
  blocks.push(
    {
      type: 'input',
      block_id: 'pulse_individuals_block',
      optional: true,
      element: {
        type: 'multi_users_select',
        action_id: 'pulse_individuals_input',
        placeholder: { type: 'plain_text', text: 'Add specific people (optional)' },
      },
      label: { type: 'plain_text', text: '🙋 Also send to individuals', emoji: true },
    },
    {
      type: 'input',
      block_id: 'pulse_also_post_block',
      optional: true,
      element: {
        type: 'conversations_select',
        action_id: 'pulse_also_post_channel',
        placeholder: { type: 'plain_text', text: 'Pick a channel (optional)' },
        filter: { include: ['public', 'private'] },
      },
      label: { type: 'plain_text', text: '📢 Also post in channel (optional)', emoji: true },
      hint: { type: 'plain_text', text: 'Post the pulse interactively in a channel so people can answer there too' },
    },
    { type: 'divider' }
  );
  // Render question slots 1..questionsVisible
  for (let i = 1; i <= questionsVisible; i++) {
    const required = i === 1;
    blocks.push(...buildQuestionBlocks(i, required, visibleLabelBlocks.has(`pulse_q${i}_type_block`)));
  }
  // "+ Add question N" button for the next slot (if < 5 questions shown)
  if (questionsVisible < 5) {
    const next = questionsVisible + 1;
    blocks.push({
      type: 'actions',
      block_id: `pulse_add_q${next}_block`,
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: `➕ Add question ${next}`, emoji: true },
        action_id: `add_question_${next}`,
        value: `add_${next}`,
      }],
    });
  }
  return blocks;
}
// ------------------------------------------------------------
//  buildQuestionBlocks — renders one question slot
//  showLabels: whether to include low/high label inputs
// ------------------------------------------------------------
function buildQuestionBlocks(num, required, showLabels = false) {
  const label = required ? `Question ${num}` : `Question ${num} (optional)`;
  const blocks = [
    {
      type: 'input',
      block_id: `pulse_q${num}_text_block`,
      optional: !required,
      element: {
        type: 'plain_text_input',
        action_id: `pulse_q${num}_text_input`,
        placeholder: { type: 'plain_text', text: 'e.g. How energised do you feel this week?' },
        max_length: 300,
      },
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
        ],
        initial_option: { text: { type: 'plain_text', text: 'Scale 1–10', emoji: true }, value: 'scale_10' },
      },
      label: { type: 'plain_text', text: '📏 Response type', emoji: true },
    },
  ];
  // Label fields only shown when a scale type is active
  if (showLabels) {
    blocks.push(
      {
        type: 'input',
        block_id: `pulse_q${num}_low_block`,
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: `pulse_q${num}_low_input`,
          placeholder: { type: 'plain_text', text: 'e.g. Not at all' },
          max_length: 50,
        },
        label: { type: 'plain_text', text: `↙️ Low label (optional)`, emoji: true },
      },
      {
        type: 'input',
        block_id: `pulse_q${num}_high_block`,
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: `pulse_q${num}_high_input`,
          placeholder: { type: 'plain_text', text: 'e.g. Extremely' },
          max_length: 50,
        },
        label: { type: 'plain_text', text: `↗️ High label (optional)`, emoji: true },
      }
    );
  }
  return blocks;
}
// ============================================================
//  Helper: derive current modal state from view blocks
// ============================================================
function getPulseViewState(view) {
  const blocks = view.blocks || [];
  // Count how many question text blocks are present
  let questionsVisible = 0;
  const visibleLabelBlocks = new Set();
  for (const b of blocks) {
    if (b.block_id && /^pulse_q\d+_text_block$/.test(b.block_id)) {
      questionsVisible++;
    }
    if (b.block_id && /^pulse_q\d+_type_block$/.test(b.block_id)) {
      // Check if the corresponding low/high blocks are present
      const num = b.block_id.match(/pulse_q(\d+)_type_block/)[1];
      const hasLow = blocks.some(lb => lb.block_id === `pulse_q${num}_low_block`);
      if (hasLow) visibleLabelBlocks.add(`pulse_q${num}_type_block`);
    }
  }
  return { questionsVisible: Math.max(questionsVisible, 1), visibleLabelBlocks };
}
// ============================================================
//  block_actions: "+ Add question N" buttons
// ============================================================
app.action(/^add_question_(\d+)$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const view = body.view;
  const { questionsVisible, visibleLabelBlocks } = getPulseViewState(view);
  // The button tells us which question number to add
  const targetQ = parseInt(action.action_id.replace('add_question_', ''), 10);
  // Only expand if this is the next logical slot
  const newVisible = Math.max(questionsVisible, targetQ);

  // FIX: Read allOptions from server-side cache via sessionId instead of private_metadata
  let allOptions = [];
  try {
    const meta = JSON.parse(view.private_metadata || '{}');
    allOptions = (meta.sessionId && pulseModalCache.get(meta.sessionId)?.allOptions) || [];
  } catch {}

  const newBlocks = buildPulseModalBlocks(allOptions, newVisible, visibleLabelBlocks);
  try {
    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: 'modal',
        callback_id: 'pulse_modal_submit',
        title: { type: 'plain_text', text: '📊 Send Pulse', emoji: true },
        submit: { type: 'plain_text', text: 'Send Pulse →', emoji: true },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: newBlocks,
        private_metadata: view.private_metadata, // pass sessionId through unchanged
      },
    });
  } catch (err) {
    logger.error('add_question view.update error:', err);
  }
});
// ============================================================
//  block_actions: response type dropdown — smart label reveal
// ============================================================
app.action(/^pulse_q(\d+)_type_input$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const view = body.view;
  const num = action.action_id.match(/pulse_q(\d+)_type_input/)[1];
  const selectedType = action.selected_option?.value;
  const { questionsVisible, visibleLabelBlocks } = getPulseViewState(view);
  const typeBlockId = `pulse_q${num}_type_block`;
  if (selectedType === 'scale_10' || selectedType === 'scale_5') {
    visibleLabelBlocks.add(typeBlockId);
  } else {
    visibleLabelBlocks.delete(typeBlockId);
  }

  // FIX: Read allOptions from server-side cache via sessionId instead of private_metadata
  let allOptions = [];
  try {
    const meta = JSON.parse(view.private_metadata || '{}');
    allOptions = (meta.sessionId && pulseModalCache.get(meta.sessionId)?.allOptions) || [];
  } catch {}

  const newBlocks = buildPulseModalBlocks(allOptions, questionsVisible, visibleLabelBlocks);
  try {
    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: 'modal',
        callback_id: 'pulse_modal_submit',
        title: { type: 'plain_text', text: '📊 Send Pulse', emoji: true },
        submit: { type: 'plain_text', text: 'Send Pulse →', emoji: true },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: newBlocks,
        private_metadata: view.private_metadata, // pass sessionId through unchanged
      },
    });
  } catch (err) {
    logger.error('pulse type dropdown view.update error:', err);
  }
});
// ============================================================
//  Pulse modal submission
// ============================================================
app.view('pulse_modal_submit', async ({ ack, body, view, client, logger }) => {
  await ack();
  const senderId = body.user.id;
  const senderName = body.user.name;
  const values = view.state.values;
  const title = values.pulse_title_block.pulse_title_input.value;
  const audienceValues = values.pulse_audience_block?.pulse_audience_select?.selected_options?.map(o => o.value) || [];
  const individualUsers = values.pulse_individuals_block?.pulse_individuals_input?.selected_users || [];
  const alsoPostChannel = values.pulse_also_post_block?.pulse_also_post_channel?.selected_conversation || null;
  // Parse questions (1–5)
  const questions = [];
  for (let i = 1; i <= 5; i++) {
    const text = values[`pulse_q${i}_text_block`]?.[`pulse_q${i}_text_input`]?.value;
    const responseType = values[`pulse_q${i}_type_block`]?.[`pulse_q${i}_type_input`]?.selected_option?.value;
    const lowLabel = values[`pulse_q${i}_low_block`]?.[`pulse_q${i}_low_input`]?.value || null;
    const highLabel = values[`pulse_q${i}_high_block`]?.[`pulse_q${i}_high_input`]?.value || null;
    if (text && responseType) {
      questions.push({ index: questions.length, text, response_type: responseType, low_label: lowLabel, high_label: highLabel });
    }
  }
  if (questions.length === 0) {
    await client.chat.postMessage({
      channel: senderId,
      text: '❌ Please add at least one question to your pulse.',
    });
    return;
  }
  const hasAudience = audienceValues.length > 0 || individualUsers.length > 0 || alsoPostChannel;
  if (!hasAudience) {
    await client.chat.postMessage({
      channel: senderId,
      text: '❌ No audience selected. Pick a group, add individuals, or choose a channel to post in.',
    });
    return;
  }
  // Resolve audience
  const { userIds, groupName, targetType, targetRaw } = await resolvePulseAudience(client, audienceValues, individualUsers, senderId, logger);
  if (userIds.length === 0 && !alsoPostChannel) {
    await client.chat.postMessage({
      channel: senderId,
      text: `❌ Couldn't resolve any recipients. Check the group has members, add individuals, or pick a channel to post in.`,
    });
    return;
  }
  // Fetch sender display name
  let senderDisplayName = senderName;
  try {
    const senderInfo = await client.users.info({ user: senderId });
    senderDisplayName = senderInfo.user?.profile?.real_name || senderInfo.user?.profile?.display_name || senderName;
  } catch {}
  // Resolve recipient user info (filter bots/deactivated/sender)
  const recipientUsers = [];
  for (const uid of userIds) {
    try {
      const info = await client.users.info({ user: uid });
      const u = info.user;
      if (u.is_bot || u.deleted || u.id === senderId) continue;
      recipientUsers.push({
        user_id: u.id,
        display_name: u.profile?.real_name || u.profile?.display_name || u.name,
      });
    } catch {
      recipientUsers.push({ user_id: uid, display_name: uid });
    }
  }
  if (recipientUsers.length === 0 && !alsoPostChannel) {
    await client.chat.postMessage({
      channel: senderId,
      text: `❌ No valid recipients found after filtering bots and inactive users.`,
    });
    return;
  }
  const campaignId = randomUUID();
  const sentAt = new Date().toISOString();
  // Save campaign to Postgres
  await db.createPulseCampaign({
    id: campaignId,
    title,
    sender_slack_id: senderId,
    target_raw: targetRaw,
    target_type: targetType,
    resolved_users: recipientUsers.map(u => u.user_id),
    questions,
  });
  // Sync to Notion (non-blocking)
  notion.createPulseCampaignRow({
    campaignId,
    title,
    senderName: senderDisplayName,
    targetRaw,
    totalRecipients: recipientUsers.length,
    sentAt,
    questionsJson: JSON.stringify(questions.map(q => q.text)),
  }).then(pageId => {
    if (pageId) db.updatePulseCampaignNotionId(campaignId, pageId);
  }).catch(err => logger.warn('Notion pulse campaign sync failed:', err.message));
  // Send DM to each recipient with first question
  let sent = 0;
  for (const recipient of recipientUsers) {
    try {
      const responseId = randomUUID();
      await db.createPulseResponse({
        id: responseId,
        campaign_id: campaignId,
        slack_user_id: recipient.user_id,
        slack_display_name: recipient.display_name,
      });
      const dmBlocks = buildPulseDMBlocks({ id: campaignId, title, questions }, 0, null);
      const dmResult = await client.chat.postMessage({
        channel: recipient.user_id,
        text: `📊 ${title} — pulse check-in from <@${senderId}>`,
        blocks: dmBlocks,
      });
      if (dmResult?.ts) {
        await db.createPulseState({
          id: randomUUID(),
          campaign_id: campaignId,
          slack_user_id: recipient.user_id,
          dm_ts: dmResult.ts,
          dm_channel: dmResult.channel,
        });
      }
      sent++;
    } catch (err) {
      logger.warn(`Could not DM pulse to ${recipient.user_id}:`, err.message);
    }
  }
  // Also post in a channel if requested — fully interactive (same blocks as DM)
  if (alsoPostChannel) {
    try {
      try { await client.conversations.join({ channel: alsoPostChannel }); } catch {}
      const channelBlocks = buildPulseDMBlocks({ id: campaignId, title, questions }, 0, null);
      const channelResult = await client.chat.postMessage({
        channel: alsoPostChannel,
        text: `📊 ${title} — pulse check-in from <@${senderId}>`,
        blocks: channelBlocks,
      });
      // Store the channel post ts/channel on the campaign so handlePulseAnswer can update it
      if (channelResult?.ts) {
        await db.storePulseChannelPost(campaignId, channelResult.channel, channelResult.ts);
      }
    } catch (err) {
      logger.warn('Could not post pulse to channel:', err.message);
    }
  }
  // Confirm to sender
  const confirmText = alsoPostChannel
    ? `*"${title}"* has been sent to *${sent}* recipient${sent !== 1 ? 's' : ''} and posted in <#${alsoPostChannel}>.\n\n📋 *${questions.length} question${questions.length !== 1 ? 's' : ''}* · 👥 *${groupName}*\n\nResponses will be collected automatically as people answer.`
    : `*"${title}"* has been sent to *${sent}* recipient${sent !== 1 ? 's' : ''}.\n\n📋 *${questions.length} question${questions.length !== 1 ? 's' : ''}* · 👥 *${groupName}*\n\nResponses will be collected automatically as people answer.`;
  await client.chat.postMessage({
    channel: senderId,
    text: `✅ Pulse *"${title}"* sent to *${sent}* recipient${sent !== 1 ? 's' : ''}.`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✅ Pulse Sent!', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: confirmText },
      },
    ],
  });
});
// FIX: use regex to match pulse_scale_1 through pulse_scale_10
// Each button needs a unique action_id — Slack rejects blocks with duplicate action_ids
app.action(/^pulse_scale_\d+$/, async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  // action.value format: "campaignId:questionIndex:score"
  const [campaignId, questionIndexStr, scoreStr] = (action.value || '').split(':');
  const questionIndex = parseInt(questionIndexStr, 10);
  const score = parseInt(scoreStr, 10);
  if (!campaignId || isNaN(questionIndex) || isNaN(score)) {
    logger.warn('pulse_scale_button: invalid action value', action.value);
    return;
  }
  await handlePulseAnswer({ client, logger, userId, campaignId, questionIndex, answer: score, score, body });
});
// ============================================================
//  Pulse: free text submit button click
// ============================================================
app.action('pulse_text_submit', async ({ ack, body, action, client, logger }) => {
  await ack();
  const userId = body.user.id;
  // action.value format: "campaignId:questionIndex"
  const [campaignId, questionIndexStr] = (action.value || '').split(':');
  const questionIndex = parseInt(questionIndexStr, 10);
  if (!campaignId || isNaN(questionIndex)) {
    logger.warn('pulse_text_submit: invalid action value', action.value);
    return;
  }
  // Extract the text input value from the block state
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
    if (!campaign) {
      logger.warn(`handlePulseAnswer: campaign ${campaignId} not found`);
      return;
    }

    let state = await db.getPulseState(campaignId, userId);

    // FIX: If no state exists, this user clicked from the channel post but wasn't
    // in the original DM recipient list (or their DM failed). Auto-register them.
    if (!state) {
      logger.info(`handlePulseAnswer: no state for ${userId} — auto-registering from channel click`);
      // Create a response row if one doesn't exist
      let existingResponse = await db.getPulseResponseByUser(campaignId, userId);
      if (!existingResponse) {
        let displayName = userId;
        try {
          const info = await client.users.info({ user: userId });
          displayName = info.user?.profile?.real_name || info.user?.profile?.display_name || info.user?.name || userId;
        } catch {}
        const responseId = randomUUID();
        await db.createPulseResponse({
          id: responseId,
          campaign_id: campaignId,
          slack_user_id: userId,
          slack_display_name: displayName,
        });
      }
      // Create state with no DM ts — answers will be sent as new DMs
      await db.createPulseState({
        id: randomUUID(),
        campaign_id: campaignId,
        slack_user_id: userId,
        dm_ts: null,
        dm_channel: null,
      });
      state = await db.getPulseState(campaignId, userId);
      if (!state) {
        logger.warn(`handlePulseAnswer: could not create state for ${userId}`);
        return;
      }
    }

    // Guard: ignore stale button clicks (already moved past this question)
    if (questionIndex !== state.current_question_index) {
      logger.warn(`handlePulseAnswer: stale click — expected q${state.current_question_index}, got q${questionIndex}`);
      return;
    }
    const questions = campaign.questions;
    const currentQuestion = questions[questionIndex];
    // Fetch the in-progress response row for this user + campaign
    const response = await db.getPulseResponseByUser(campaignId, userId);
    if (!response) {
      logger.warn(`handlePulseAnswer: no response row for ${userId} / ${campaignId}`);
      return;
    }
    // Append this answer
    const answers = Array.isArray(response.answers) ? response.answers : [];
    answers[questionIndex] = {
      question_index: questionIndex,
      question_text: currentQuestion.text,
      response_type: currentQuestion.response_type,
      answer,
      score: score != null ? score : null,
    };
    await db.updatePulseResponseAnswers(response.id, answers);
    const nextIndex = questionIndex + 1;
    const isComplete = nextIndex >= questions.length;
    // Determine whether the answer came from the channel post or a DM
    const clickedChannel = body?.channel?.id || body?.container?.channel_id;
    const answeredFromChannel = campaign.channel_post_channel && clickedChannel === campaign.channel_post_channel;
    if (isComplete) {
      // All questions answered — complete the response
      await db.completePulseResponse(response.id);
      await db.deletePulseState(campaignId, userId);
      // Sync to Notion (non-blocking)
      const respondedAt = new Date().toISOString();
      notion.createPulseResponseRow({
        campaignId,
        respondentName: response.slack_display_name,
        slackId: userId,
        respondedAt,
        pulseTitle: campaign.title,
      }).then(async (responsePageId) => {
        if (responsePageId) {
          await db.updatePulseResponseNotionId(response.id, responsePageId);
          await notion.updatePulseResponseAnswers({ responsePageId, answers });
        }
        // Update respondent count on campaign
        if (campaign.notion_campaign_page_id) {
          const { rows: completedRows } = await db.countCompletedPulseResponses(campaignId);
          const count = completedRows?.[0]?.count ? parseInt(completedRows[0].count) : 1;
          await notion.updatePulseCampaignRespondentCount({
            campaignPageId: campaign.notion_campaign_page_id,
            respondentCount: count,
          });
        }
      }).catch(err => logger.warn('Notion pulse response sync failed:', err.message));
      const completionBlocks = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🎉 All done!', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Thanks for completing *"${campaign.title}"*! Your responses have been recorded. 🙏`,
          },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${buildPulseProgressBar(questions.length, questions.length)} ${questions.length}/${questions.length} questions answered` }],
        },
      ];
      if (state.dm_channel && state.dm_ts) {
        // Update existing DM thread with completion message
        try {
          await client.chat.update({
            channel: state.dm_channel,
            ts: state.dm_ts,
            text: `🎉 Thanks for completing "${campaign.title}"!`,
            blocks: completionBlocks,
          });
        } catch (err) {
          logger.warn('Could not update pulse DM on completion:', err.message);
        }
      } else {
        // No DM thread — send completion as a new DM (don't update shared channel post)
        try {
          await client.chat.postMessage({
            channel: userId,
            text: `🎉 Thanks for completing "${campaign.title}"!`,
            blocks: completionBlocks,
          });
        } catch (err) {
          logger.warn('Could not send completion DM:', err.message);
        }
      }
    } else {
      // Advance to next question
      await db.updatePulseStateQuestion(campaignId, userId, nextIndex);
      const nextBlocks = buildPulseDMBlocks(campaign, nextIndex, null);

      if (state.dm_channel && state.dm_ts) {
        // Has an existing DM thread — update it in place
        try {
          await client.chat.update({
            channel: state.dm_channel,
            ts: state.dm_ts,
            text: `📊 ${campaign.title} — question ${nextIndex + 1} of ${questions.length}`,
            blocks: nextBlocks,
          });
        } catch (err) {
          logger.warn('Could not update pulse DM for next question:', err.message);
        }
      } else {
        // No DM thread (user answered from channel post) — send next question as a new DM
        // This avoids updating the shared channel post which would affect all respondents
        try {
          const dmResult = await client.chat.postMessage({
            channel: userId,
            text: `📊 ${campaign.title} — question ${nextIndex + 1} of ${questions.length}`,
            blocks: nextBlocks,
          });
          // Store the DM ts so subsequent questions can update in place
          if (dmResult?.ts) {
            await db.createPulseState({
              id: randomUUID(),
              campaign_id: campaignId,
              slack_user_id: userId,
              dm_ts: dmResult.ts,
              dm_channel: dmResult.channel,
            });
          }
        } catch (err) {
          logger.warn('Could not send next question DM:', err.message);
        }
      }
    }
  } catch (err) {
    logger.error('handlePulseAnswer error:', err);
  }
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
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 ${campaign.title}`, emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${progressBar}  Question ${questionIndex + 1} of ${total}` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${question.text}*` },
    },
  ];
  if (question.response_type === 'scale_10') {
    // Low/high labels
    if (question.low_label || question.high_label) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${question.low_label ? `_${question.low_label}_ ←` : ''} ${question.high_label ? `→ _${question.high_label}_` : ''}`.trim(),
        }],
      });
    }
    // Two rows of buttons: 1-5 and 6-10
    // Each button gets a unique action_id (pulse_scale_1 … pulse_scale_10)
    // Slack rejects messages with duplicate action_ids
    blocks.push({
      type: 'actions',
      elements: [1, 2, 3, 4, 5].map(n => ({
        type: 'button',
        text: { type: 'plain_text', text: String(n), emoji: true },
        action_id: `pulse_scale_${n}`,
        value: `${campaign.id}:${questionIndex}:${n}`,
      })),
    });
    blocks.push({
      type: 'actions',
      elements: [6, 7, 8, 9, 10].map(n => ({
        type: 'button',
        text: { type: 'plain_text', text: String(n), emoji: true },
        action_id: `pulse_scale_${n}`,
        value: `${campaign.id}:${questionIndex}:${n}`,
      })),
    });
  } else if (question.response_type === 'scale_5') {
    if (question.low_label || question.high_label) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${question.low_label ? `_${question.low_label}_ ←` : ''} ${question.high_label ? `→ _${question.high_label}_` : ''}`.trim(),
        }],
      });
    }
    blocks.push({
      type: 'actions',
      elements: [1, 2, 3, 4, 5].map(n => ({
        type: 'button',
        text: { type: 'plain_text', text: String(n), emoji: true },
        action_id: `pulse_scale_${n}`,
        value: `${campaign.id}:${questionIndex}:${n}`,
      })),
    });
  } else {
    // Free text
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
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Submit →', emoji: true },
        action_id: 'pulse_text_submit',
        value: `${campaign.id}:${questionIndex}`,
        style: 'primary',
      }],
    });
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
async function resolvePulseAudience(client, audienceValues, individualUsers, senderId, logger) {
  let userIds = [];
  const groupNameParts = [];
  let targetType = 'manual';
  let targetRaw = '';
  for (const audienceValue of audienceValues) {
    try {
      if (audienceValue.startsWith('slack_ug:')) {
        const [, ugId, ugName] = audienceValue.split(':');
        groupNameParts.push(ugName);
        targetType = 'usergroup';
        targetRaw = audienceValue;
        const membersRes = await client.usergroups.users.list({ usergroup: ugId });
        userIds = userIds.concat(membersRes.users || []);
      } else if (audienceValue.startsWith('channel:')) {
        const [, channelId, chanName] = audienceValue.split(':');
        groupNameParts.push(`#${chanName}`);
        targetType = 'channel';
        targetRaw = audienceValue;
        const membersRes = await client.conversations.members({ channel: channelId });
        userIds = userIds.concat((membersRes.members || []).filter(id => id !== senderId));
      }
    } catch (err) {
      logger.error('Error resolving pulse audience:', err);
    }
  }
  if (individualUsers.length > 0) {
    if (!targetRaw) targetRaw = 'individuals';
    if (groupNameParts.length === 0) targetType = 'manual';
  }
  const allUserIds = [...new Set([...userIds, ...individualUsers])];
  let groupName;
  if (groupNameParts.length > 0) {
    groupName = groupNameParts.join(' + ');
    if (individualUsers.length > 0) {
      groupName += ` + ${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
    }
  } else if (individualUsers.length > 0) {
    groupName = `${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  } else {
    groupName = 'Unknown Group';
  }
  return { userIds: allUserIds, groupName, targetType, targetRaw };
}
// ============================================================
//  Start
// ============================================================
(async () => {
  await app.start();
  console.log(`\n✅ Announce Bot is running!`);
  console.log(`   Slack Socket Mode: ${process.env.SLACK_APP_TOKEN ? 'enabled' : 'disabled (using HTTP)'}`);
  console.log(`   Port: ${process.env.PORT || 3456}\n`);
  console.log(`   Commands available:`);
  console.log(`     /announce          - Send a tracked announcement`);
  console.log(`     /radarping         - Alias for /announce`);
  console.log(`     /announce-status   - View read receipts`);
  console.log(`     /radarpulse        - Send a pulse quiz\n`);
})();
