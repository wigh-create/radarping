/**
 * notion.js - Syncs announcements and read receipts to Notion
 * Requires: NOTION_API_KEY, NOTION_DATABASE_ID in .env
 */

const DATABASE_ID = process.env.NOTION_DATABASE_ID; // Announcement Tracker
const RECEIPTS_DATABASE_ID = '0a61c5da2338408e866e2479060bc0f6'; // Read Receipts
const PULSE_CAMPAIGNS_DB_ID = process.env.NOTION_PULSE_CAMPAIGNS_DB_ID || 'e729537b2b2c4d2fa68d18af614b8d54';
const PULSE_RESPONSES_DB_ID = process.env.NOTION_PULSE_RESPONSES_DB_ID || '13541ab001f94801a799b04de1972337';
const API_KEY = process.env.NOTION_API_KEY;

if (!API_KEY || API_KEY === 'secret_your-key-here') {
    console.log('ℹ️ Notion sync disabled (no NOTION_API_KEY set)');
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
        console.warn(`⚠️ Notion sync failed (create announcement): ${err.message}`);
        return null;
    }
}

// Create one row per recipient in Read Receipts database
async function createRecipientRows({ announcementPageId, recipients, sentAt }) {
    if (!ENABLED || !announcementPageId) return;

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
            console.warn(`⚠️ Notion: could not create receipt row for ${recipient.user_name}: ${err.message}`);
        }
    }

    console.log(`✅ Notion: created ${recipients.length} recipient rows`);
}

// Mark a specific person as having read
async function markRecipientRead({ announcementId, userId, userName = null }) {
    if (!ENABLED) return;

    try {
        const announcementPageId = await findPageByAnnouncementId(announcementId);
        if (!announcementPageId) return;

        const now = new Date().toISOString();

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
        console.warn(`⚠️ Notion: could not mark recipient read: ${err.message}`);
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
        console.warn(`⚠️ Notion sync failed (update stats): ${err.message}`);
    }
}

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
        console.warn(`⚠️ Notion: could not find announcement page: ${err.message}`);
        return null;
    }
}

// ============================================================
// Pulse Campaigns DB
// Property names match the actual Notion DB schema:
//   Name (title), Sender, Target, Sent At, Total Sent,
//   Respondents, Response Rate (formula), Pulse ID, Questions JSON
// ============================================================

async function createPulseCampaignRow({ campaignId, title, senderName, targetRaw, totalRecipients, sentAt, questionsJson }) {
    if (!ENABLED) return null;

    try {
        const result = await notionFetch('/pages', 'POST', {
            parent: { database_id: PULSE_CAMPAIGNS_DB_ID },
            properties: {
                'Name':          { title: [{ text: { content: title || 'Untitled Pulse' } }] },
                'Pulse ID':      { rich_text: [{ text: { content: campaignId } }] },
                'Sender':        { rich_text: [{ text: { content: senderName || 'Unknown' } }] },
                'Target':        { rich_text: [{ text: { content: targetRaw || '' } }] },
                'Total Sent':    { number: totalRecipients || 0 },
                'Respondents':   { number: 0 },
                'Sent At':       { date: { start: sentAt || new Date().toISOString() } },
                'Questions JSON':{ rich_text: [{ text: { content: (questionsJson || '').slice(0, 2000) } }] },
            },
        });

        console.log(`✅ Notion: created pulse campaign row for ${campaignId.slice(0, 8)}`);
        return result.id;
    } catch (err) {
        console.warn(`⚠️ Notion sync failed (create pulse campaign): ${err.message}`);
        return null;
    }
}

// ============================================================
// Pulse Responses DB
// Property names match the actual Notion DB schema:
//   Name (title), Respondent, Slack ID, Pulse Title, Pulse ID,
//   Responded At, Q1 Text, Q1 Score, Q1 Response … Q5
// ============================================================

async function createPulseResponseRow({ campaignId, respondentName, slackId, respondedAt, pulseTitle }) {
    if (!ENABLED) return null;

    try {
        const result = await notionFetch('/pages', 'POST', {
            parent: { database_id: PULSE_RESPONSES_DB_ID },
            properties: {
                'Name':         { title: [{ text: { content: respondentName || slackId || 'Unknown' } }] },
                'Respondent':   { rich_text: [{ text: { content: respondentName || slackId || '' } }] },
                'Slack ID':     { rich_text: [{ text: { content: slackId || '' } }] },
                'Pulse Title':  { rich_text: [{ text: { content: pulseTitle || '' } }] },
                'Pulse ID':     { rich_text: [{ text: { content: campaignId } }] },
                'Responded At': { date: { start: respondedAt || new Date().toISOString() } },
            },
        });

        console.log(`✅ Notion: created pulse response row for ${slackId}`);
        return result.id;
    } catch (err) {
        console.warn(`⚠️ Notion sync failed (create pulse response): ${err.message}`);
        return null;
    }
}

// Update Q1–Q5 columns on a Pulse Response row
// answers: [{ question_text, response_type, answer, score }]
async function updatePulseResponseAnswers({ responsePageId, answers }) {
    if (!ENABLED || !responsePageId) return;

    try {
        const props = {};
        answers.forEach((a, i) => {
            const qNum = i + 1;
            if (qNum > 20) return;

            // Q1 Text — the question itself
            if (a.question_text) {
                props[`Q${qNum} Text`] = { rich_text: [{ text: { content: String(a.question_text).slice(0, 2000) } }] };
            }

            // Q1 Score — numeric score (for scale questions)
            if (a.score != null) {
                props[`Q${qNum} Score`] = { number: a.score };
            }

            // Q1 Response — the answer value (text for free text, score as string for scales)
            const answerText = a.answer != null ? String(a.answer) : '';
            if (answerText) {
                props[`Q${qNum} Response`] = { rich_text: [{ text: { content: answerText.slice(0, 2000) } }] };
            }
        });

        await notionFetch(`/pages/${responsePageId}`, 'PATCH', { properties: props });
        console.log(`✅ Notion: updated pulse response answers on ${responsePageId.slice(0, 8)}`);
    } catch (err) {
        console.warn(`⚠️ Notion sync failed (update pulse response answers): ${err.message}`);
    }
}

// Increment the respondent count on a Pulse Campaign row
async function updatePulseCampaignRespondentCount({ campaignPageId, respondentCount }) {
    if (!ENABLED || !campaignPageId) return;

    try {
        await notionFetch(`/pages/${campaignPageId}`, 'PATCH', {
            properties: {
                'Respondents': { number: respondentCount },
            },
        });
        console.log(`✅ Notion: updated pulse campaign respondent count to ${respondentCount}`);
    } catch (err) {
        console.warn(`⚠️ Notion sync failed (update pulse campaign respondent count): ${err.message}`);
    }
}

module.exports = {
    createAnnouncementPage,
    createRecipientRows,
    markRecipientRead,
    updateReadStats,
    ENABLED,
    createPulseCampaignRow,
    createPulseResponseRow,
    updatePulseResponseAnswers,
    updatePulseCampaignRespondentCount,
};
