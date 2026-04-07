/**
 * notion.js - Syncs announcements and read receipts to Notion
 * Requires: NOTION_API_KEY, NOTION_DATABASE_ID in .env
 */

const DATABASE_ID = process.env.NOTION_DATABASE_ID;         // Announcement Tracker
const RECEIPTS_DATABASE_ID = '0a61c5da2338408e866e2479060bc0f6'; // Read Receipts
const API_KEY = process.env.NOTION_API_KEY;

if (!API_KEY || API_KEY === 'secret_your-key-here') {
  console.log('ℹ️  Notion sync disabled (no NOTION_API_KEY set)');
}

const ENABLED = API_KEY && API_KEY !== 'secret_your-key-here';

async function notionFetch(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion API error ${res.status}: ${err}`);
  }

  return res.json();
}

// Create a new row in Announcement Tracker when an announcement is sent
// Returns the Notion page ID so we can link recipients to it
async function createAnnouncementPage({ announcementId, title, message, senderName, groupName, totalRecipients, linkUrl, sentAt }) {
  if (!ENABLED) return null;

  try {
    const result = await notionFetch('/pages', 'POST', {
      parent: { database_id: DATABASE_ID },
      properties: {
        'Announcement': { title: [{ text: { content: title || message.slice(0, 100) } }] },
        'Status': { select: { name: 'Active' } },
        'Sent By': { rich_text: [{ text: { content: senderName || 'Unknown' } }] },
        'Sent At': { date: { start: sentAt || new Date().toISOString() } },
        'Audience': { rich_text: [{ text: { content: groupName || '' } }] },
        'Total Recipients': { number: totalRecipients || 0 },
        'Read Count': { number: 0 },
        'Pending Count': { number: totalRecipients || 0 },
        'Read %': { number: 0 },
        'Announcement ID': { rich_text: [{ text: { content: announcementId } }] },
        ...(linkUrl ? { 'Link': { url: linkUrl } } : {}),
      },
    });

    console.log(`✅ Notion: created announcement row for ${announcementId.slice(0, 8)}`);
    return result.id;
  } catch (err) {
    console.warn(`⚠️  Notion sync failed (create announcement): ${err.message}`);
    return null;
  }
}

// Create one row per recipient in Read Receipts database
async function createRecipientRows({ announcementPageId, recipients, sentAt }) {
  if (!ENABLED || !announcementPageId) return;

  // Notion API allows one page at a time — batch with small delay to avoid rate limits
  for (const recipient of recipients) {
    try {
      await notionFetch('/pages', 'POST', {
        parent: { database_id: RECEIPTS_DATABASE_ID },
        properties: {
          'Name': { title: [{ text: { content: recipient.user_name || recipient.user_id } }] },
          'Status': { select: { name: '⏳ Pending' } },
          'Slack User ID': { rich_text: [{ text: { content: recipient.user_id } }] },
          'Announcement': { relation: [{ id: announcementPageId }] },
          'Sent At': { date: { start: sentAt || new Date().toISOString() } },
        },
      });
    } catch (err) {
      console.warn(`⚠️  Notion: could not create receipt row for ${recipient.user_name}: ${err.message}`);
    }
  }

  console.log(`✅ Notion: created ${recipients.length} recipient rows`);
}

// Mark a specific person as having read — upsert: find row or create it, then mark read
async function markRecipientRead({ announcementId, userId, userName = null }) {
  if (!ENABLED) return;

  try {
    const announcementPageId = await findPageByAnnouncementId(announcementId);
    if (!announcementPageId) return;

    const now = new Date().toISOString();

    // Check if a row already exists for this person + announcement
    const result = await notionFetch(`/databases/${RECEIPTS_DATABASE_ID}/query`, 'POST', {
      filter: {
        and: [
          { property: 'Slack User ID', rich_text: { equals: userId } },
          { property: 'Announcement', relation: { contains: announcementPageId } },
        ],
      },
      page_size: 1,
    });

    const existingPageId = result.results?.[0]?.id;

    if (existingPageId) {
      // Row exists — just update status (idempotent, won't overwrite an earlier read_at)
      const alreadyRead = result.results[0].properties?.['Read At']?.date?.start;
      if (!alreadyRead) {
        await notionFetch(`/pages/${existingPageId}`, 'PATCH', {
          properties: {
            ...(userName ? { 'Name': { title: [{ text: { content: userName } }] } } : {}),
            'Status': { select: { name: '✅ Read' } },
            'Read At': { date: { start: now } },
          },
        });
      }
    } else {
      // Row doesn't exist (clicked from channel, wasn't in original list) — create and mark read
      await notionFetch('/pages', 'POST', {
        parent: { database_id: RECEIPTS_DATABASE_ID },
        properties: {
          'Name': { title: [{ text: { content: userName || userId } }] },
          'Status': { select: { name: '✅ Read' } },
          'Slack User ID': { rich_text: [{ text: { content: userId } }] },
          'Announcement': { relation: [{ id: announcementPageId }] },
          'Read At': { date: { start: now } },
        },
      });
    }

    console.log(`✅ Notion: marked ${userId} as read (upsert)`);
  } catch (err) {
    console.warn(`⚠️  Notion: could not mark recipient read: ${err.message}`);
  }
}

// Update aggregate stats on the announcement row
async function updateReadStats({ announcementId, readCount, pendingCount, totalRecipients }) {
  if (!ENABLED) return;

  try {
    const pageId = await findPageByAnnouncementId(announcementId);
    if (!pageId) return;

    const pct = totalRecipients > 0 ? readCount / totalRecipients : 0;
    const isComplete = pendingCount === 0 && totalRecipients > 0;

    await notionFetch(`/pages/${pageId}`, 'PATCH', {
      properties: {
        'Read Count': { number: readCount },
        'Pending Count': { number: pendingCount },
        'Read %': { number: pct },
        ...(isComplete ? { 'Status': { select: { name: 'Complete' } } } : {}),
      },
    });

    console.log(`✅ Notion: updated stats ${announcementId.slice(0, 8)} — ${readCount}/${totalRecipients}`);
  } catch (err) {
    console.warn(`⚠️  Notion sync failed (update stats): ${err.message}`);
  }
}

// Find an Announcement Tracker page by the bot's internal announcement ID
async function findPageByAnnouncementId(announcementId) {
  try {
    const result = await notionFetch(`/databases/${DATABASE_ID}/query`, 'POST', {
      filter: {
        property: 'Announcement ID',
        rich_text: { equals: announcementId },
      },
      page_size: 1,
    });

    return result.results?.[0]?.id || null;
  } catch (err) {
    console.warn(`⚠️  Notion: could not find announcement page: ${err.message}`);
    return null;
  }
}

module.exports = { createAnnouncementPage, createRecipientRows, markRecipientRead, updateReadStats, ENABLED };
