/**
 * Announce Bot - Tracked Slack Broadcasts with Read Receipts
 *
 * Commands:
 *   /announce        - Compose and send an announcement to groups
 *   /announce-status - Check read receipts for your announcements
 *   /groups          - Manage your custom recipient groups
 */
require('dotenv').config();
const { App } = require('@slack/bolt');
const { randomUUID } = require('crypto');
const db = require('./db');
const notion = require('./notion');

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

    const customGroups = await db.getGroups();
    const customOptions = customGroups.map(g => ({
      text: { type: 'plain_text', text: `📋 ${g.name} (custom, ${g.member_ids.length} members)`, emoji: true },
      value: `custom:${g.id}:${g.name}`,
    }));

    let channelOptions = [];
    try {
      const chanRes = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200, exclude_archived: true });
      const botChannels = (chanRes.channels || []).filter(c => c.is_member);
      channelOptions = botChannels.slice(0, 20).map(c => ({
        text: { type: 'plain_text', text: `#${c.name}`, emoji: true },
        value: `channel:${c.id}:${c.name}`,
      }));
    } catch (e) {
      logger.warn('Could not fetch channels:', e.message);
    }

    const allOptions = [...ugOptions.slice(0, 60), ...customOptions.slice(0, 20), ...channelOptions.slice(0, 19)];

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
          type: 'static_select',
          action_id: 'audience_select',
          placeholder: { type: 'plain_text', text: 'Choose a group or channel (optional)...' },
          options: allOptions,
        },
        label: { type: 'plain_text', text: '👥 Send to group', emoji: true },
        hint: { type: 'plain_text', text: 'Optional — skip if you\'re only sending to individuals below' },
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
  const audienceValue = values.audience_block?.audience_select?.selected_option?.value;
  const alsoPostChannel = values.also_post_block?.also_post_channel?.selected_conversation;
  const individualUsers = values.individual_block?.individual_users?.selected_users || [];

  const hasAudience = (audienceValue && audienceValue !== 'none') || individualUsers.length > 0 || alsoPostChannel;
  if (!hasAudience) {
    await client.chat.postMessage({
      channel: senderId,
      text: '❌ No audience selected. Pick a group, add individuals, or choose a channel to post in.',
    });
    return;
  }

  // Resolve audience to a list of user IDs
  let userIds = [];
  let groupName = 'Unknown Group';
  let targetType = 'manual';
  let targetId = null;

  try {
    if (audienceValue && audienceValue.startsWith('slack_ug:')) {
      // Slack User Group
      const [, ugId, ugName] = audienceValue.split(':');
      groupName = ugName;
      targetType = 'usergroup';
      targetId = ugId;

      const membersRes = await client.usergroups.users.list({ usergroup: ugId });
      userIds = membersRes.users || [];

    } else if (audienceValue && audienceValue.startsWith('custom:')) {
      // Custom in-app group
      const [, groupId, gName] = audienceValue.split(':');
      groupName = gName;
      targetType = 'custom';
      targetId = groupId;

      const group = await db.getGroup(groupId);
      userIds = group ? group.member_ids : [];

    } else if (audienceValue && audienceValue.startsWith('channel:')) {
      // Channel - get members
      const [, channelId, chanName] = audienceValue.split(':');
      groupName = `#${chanName}`;
      targetType = 'channel';
      targetId = channelId;

      const membersRes = await client.conversations.members({ channel: channelId });
      userIds = (membersRes.members || []).filter(id => id !== senderId);
    }
  } catch (err) {
    logger.error('Error resolving audience:', err);
  }

  // Merge in any individually selected users (deduplicated)
  const allUserIds = [...new Set([...userIds, ...individualUsers])];
  if (individualUsers.length > 0 && (!audienceValue || audienceValue === 'none')) {
    groupName = `${individualUsers.length} individual${individualUsers.length > 1 ? 's' : ''}`;
  }

  if (allUserIds.length === 0 && !alsoPostChannel) {
    await client.chat.postMessage({
      channel: senderId,
      text: `❌ Couldn't resolve any recipients. Check the group has members, add individuals, or pick a channel to post in.`,
    });
    return;
  }
  if (allUserIds.length === 0 && alsoPostChannel) {
    groupName = 'Channel post only';
  }
  userIds = allUserIds;

  // Create announcement record
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
  await client.chat.postMessage({
    channel: senderId,
    text: `✅ Announcement sent to *${groupName}*`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ *Announcement sent!*\n📣 *"${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"*\n\n👥 Sent to *${groupName}* — *${sent}/${recipientUsers.length}* DMs delivered.` },
      },
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
      },
    ],
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

  // Update the message where the button was clicked
  try {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: '✅ You\'ve confirmed you\'ve read this announcement.',
      blocks: readBlocks(body.message.blocks),
    });
  } catch (err) {
    logger.warn('Could not update clicked message:', err.message);
  }

  // Also update the DM if they clicked from a channel (or the channel post if they clicked from DM)
  try {
    const recipientInfo = await db.getRecipient(announcementId, userId);
    if (recipientInfo?.dm_ts && recipientInfo.dm_channel !== body.channel.id) {
      // Clicked from channel — update their DM too
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
//  /groups - Manage custom recipient groups
// ============================================================
app.command('/groups', async ({ ack, body, client, logger }) => {
  await ack();

  const senderId = body.user.id;
  const args = (body.text || '').trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'create') {
    // /groups create "Group Name" @user1 @user2
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'create_group_modal',
        title: { type: 'plain_text', text: '👥 Create Group', emoji: true },
        submit: { type: 'plain_text', text: 'Create', emoji: true },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'group_name_block',
            element: {
              type: 'plain_text_input',
              action_id: 'group_name_input',
              placeholder: { type: 'plain_text', text: 'e.g. UK Sales Team, EMEA Managers...' },
            },
            label: { type: 'plain_text', text: 'Group Name', emoji: true },
          },
          {
            type: 'input',
            block_id: 'group_members_block',
            element: {
              type: 'multi_users_select',
              action_id: 'group_members_input',
              placeholder: { type: 'plain_text', text: 'Search for team members...' },
            },
            label: { type: 'plain_text', text: 'Members', emoji: true },
          },
        ],
      },
    });
  } else if (subcommand === 'delete' && args[1]) {
    const groupId = args[1];
    await db.deleteGroup(groupId);
    await client.chat.postMessage({ channel: senderId, text: `🗑️ Group deleted.` });
  } else {
    // List groups
    const groups = await db.getGroups();

    if (groups.length === 0) {
      await client.chat.postMessage({
        channel: senderId,
        text: '📭 No custom groups yet.\n\nUse `/groups create` to create one — or just use Slack User Groups and channels, which are auto-detected in `/announce`.',
      });
      return;
    }

    const lines = groups.map(g => `• *${g.name}* — ${g.member_ids.length} members (ID: \`${g.id.slice(0, 8)}\`)`).join('\n');
    await client.chat.postMessage({
      channel: senderId,
      text: `👥 *Your Custom Groups:*\n${lines}\n\n_Use \`/groups create\` to add a new group, or \`/groups delete <id>\` to remove one._`,
    });
  }
});

// ============================================================
//  Create group modal submit
// ============================================================
app.view('create_group_modal', async ({ ack, body, view, client, logger }) => {
  await ack();

  const createdBy = body.user.id;
  const values = view.state.values;
  const name = values.group_name_block.group_name_input.value;
  const memberIds = values.group_members_block.group_members_input.selected_users || [];

  const id = randomUUID();
  await db.saveGroup({ id, name, member_ids: memberIds, created_by: createdBy });

  await client.chat.postMessage({
    channel: createdBy,
    text: `✅ Group *${name}* created with ${memberIds.length} members.\n\nNow use \`/announce\` and you'll see this group in the audience picker!`,
  });
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
//  Start
// ============================================================
(async () => {
  await app.start();
  console.log(`\n✅ Announce Bot is running!`);
  console.log(`   Slack Socket Mode: ${process.env.SLACK_APP_TOKEN ? 'enabled' : 'disabled (using HTTP)'}`);
  console.log(`   Port: ${process.env.PORT || 3456}\n`);
  console.log(`   Commands available:`);
  console.log(`     /announce          - Send a tracked announcement`);
  console.log(`     /announce-status   - View read receipts`);
  console.log(`     /groups            - Manage custom recipient groups\n`);
})();
