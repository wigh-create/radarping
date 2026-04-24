/**
 * db.js - PostgreSQL wrapper using pg
 *
 * Replaces sql.js (SQLite file) with a proper Postgres connection.
 * DATABASE_URL is set automatically by Railway when you add a Postgres plugin.
 */
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres requires SSL in production; rejectUnauthorized: false handles self-signed certs
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
// ============================================================
//  Schema bootstrap — runs on startup, safe to re-run
// ============================================================
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      message TEXT NOT NULL,
      group_name TEXT,
      target_type TEXT NOT NULL,
      target_id TEXT,
      total_recipients INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipients (
      id SERIAL PRIMARY KEY,
      announcement_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      read_at INTEGER,
      dm_ts TEXT,
      dm_channel TEXT,
      UNIQUE(announcement_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_ids TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_campaigns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sender_slack_id TEXT NOT NULL,
      target_raw TEXT,
      target_type TEXT,
      resolved_users TEXT NOT NULL DEFAULT '[]',
      questions TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
      notion_campaign_page_id TEXT,
      channel_post_channel TEXT,
      channel_post_ts TEXT
    )
  `);
  // Migrate existing tables: add channel post columns if they don't exist yet
  await pool.query(`
    ALTER TABLE pulse_campaigns
      ADD COLUMN IF NOT EXISTS channel_post_channel TEXT,
      ADD COLUMN IF NOT EXISTS channel_post_ts TEXT
  `).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_responses (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      slack_display_name TEXT,
      answers TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
      completed_at INTEGER,
      notion_row_id TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_state (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      current_question_index INTEGER NOT NULL DEFAULT 0,
      dm_ts TEXT,
      dm_channel TEXT,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
      UNIQUE(campaign_id, slack_user_id)
    )
  `);
  // ── Scheduled posts ──────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id           SERIAL  PRIMARY KEY,
      type         TEXT    NOT NULL,
      created_by   TEXT    NOT NULL,
      payload      JSONB   NOT NULL,
      scheduled_at INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      sent_at      INTEGER,
      created_at   INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due
      ON scheduled_posts (status, scheduled_at)
      WHERE status = 'pending'
  `);
}
initSchema().catch(err => console.error('DB schema init error:', err));
// ============================================================
//  Announcements
// ============================================================
async function createAnnouncement({ id, sender_id, sender_name, message, group_name, target_type, target_id }) {
  await pool.query(
    `INSERT INTO announcements (id, sender_id, sender_name, message, group_name, target_type, target_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, sender_id, sender_name, message, group_name, target_type, target_id]
  );
}
async function updateRecipientCount(id, count) {
  await pool.query(
    `UPDATE announcements SET total_recipients = $1 WHERE id = $2`,
    [count, id]
  );
}
async function getAnnouncement(id) {
  const { rows } = await pool.query(
    `SELECT * FROM announcements WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}
async function getRecentAnnouncements(senderId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM announcements WHERE sender_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [senderId, limit]
  );
  return rows;
}
// ============================================================
//  Recipients
// ============================================================
async function addRecipients(announcementId, users) {
  // users: [{ user_id, user_name }]
  for (const u of users) {
    await pool.query(
      `INSERT INTO recipients (announcement_id, user_id, user_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (announcement_id, user_id) DO NOTHING`,
      [announcementId, u.user_id, u.user_name || '']
    );
  }
}
async function storeDmTs(announcementId, userId, dmTs, dmChannel) {
  await pool.query(
    `UPDATE recipients SET dm_ts = $1, dm_channel = $2
     WHERE announcement_id = $3 AND user_id = $4`,
    [dmTs, dmChannel, announcementId, userId]
  );
}
async function getRecipient(announcementId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM recipients WHERE announcement_id = $1 AND user_id = $2`,
    [announcementId, userId]
  );
  return rows[0] || null;
}
async function markRead(announcementId, userId) {
  await pool.query(
    `UPDATE recipients
     SET read_at = EXTRACT(EPOCH FROM NOW())::INTEGER
     WHERE announcement_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [announcementId, userId]
  );
}
async function getRecipientStats(announcementId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count
     FROM recipients WHERE announcement_id = $1`,
    [announcementId]
  );
  const row = rows[0] || { total: 0, read_count: 0 };
  return {
    total: parseInt(row.total) || 0,
    read_count: parseInt(row.read_count) || 0,
  };
}
async function getPendingReaders(announcementId) {
  const { rows } = await pool.query(
    `SELECT user_id, user_name FROM recipients
     WHERE announcement_id = $1 AND read_at IS NULL`,
    [announcementId]
  );
  return rows;
}
async function getAllReaders(announcementId) {
  const { rows } = await pool.query(
    `SELECT user_id, user_name, read_at FROM recipients
     WHERE announcement_id = $1`,
    [announcementId]
  );
  return rows;
}
// ============================================================
//  Custom Groups
// ============================================================
async function saveGroup({ id, name, member_ids, created_by }) {
  await pool.query(
    `INSERT INTO groups (id, name, member_ids, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = $2, member_ids = $3`,
    [id, name, JSON.stringify(member_ids), created_by]
  );
}
async function getGroups() {
  const { rows } = await pool.query(`SELECT * FROM groups ORDER BY name`);
  return rows.map(r => ({ ...r, member_ids: JSON.parse(r.member_ids) }));
}
async function getGroup(id) {
  const { rows } = await pool.query(`SELECT * FROM groups WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], member_ids: JSON.parse(rows[0].member_ids) };
}
async function deleteGroup(id) {
  await pool.query(`DELETE FROM groups WHERE id = $1`, [id]);
}
// ============================================================
//  Pulse Campaigns
// ============================================================
async function createPulseCampaign({ id, title, sender_slack_id, target_raw, target_type, resolved_users, questions }) {
  await pool.query(
    `INSERT INTO pulse_campaigns (id, title, sender_slack_id, target_raw, target_type, resolved_users, questions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, title, sender_slack_id, target_raw || '', target_type || 'manual', JSON.stringify(resolved_users || []), JSON.stringify(questions || [])]
  );
}
async function getPulseCampaign(id) {
  const { rows } = await pool.query(`SELECT * FROM pulse_campaigns WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  return {
    ...rows[0],
    resolved_users: JSON.parse(rows[0].resolved_users),
    questions: JSON.parse(rows[0].questions),
  };
}
async function updatePulseCampaignNotionId(id, notionPageId) {
  await pool.query(
    `UPDATE pulse_campaigns SET notion_campaign_page_id = $1 WHERE id = $2`,
    [notionPageId, id]
  );
}
async function storePulseChannelPost(campaignId, channelId, ts) {
  await pool.query(
    `UPDATE pulse_campaigns SET channel_post_channel = $1, channel_post_ts = $2 WHERE id = $3`,
    [channelId, ts, campaignId]
  );
}
// ============================================================
//  Pulse Responses
// ============================================================
async function createPulseResponse({ id, campaign_id, slack_user_id, slack_display_name }) {
  await pool.query(
    `INSERT INTO pulse_responses (id, campaign_id, slack_user_id, slack_display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, campaign_id, slack_user_id, slack_display_name || '']
  );
}
async function getPulseResponse(id) {
  const { rows } = await pool.query(`SELECT * FROM pulse_responses WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], answers: JSON.parse(rows[0].answers) };
}
async function updatePulseResponseAnswers(id, answers) {
  await pool.query(
    `UPDATE pulse_responses SET answers = $1 WHERE id = $2`,
    [JSON.stringify(answers), id]
  );
}
async function completePulseResponse(id) {
  await pool.query(
    `UPDATE pulse_responses SET completed_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = $1`,
    [id]
  );
}
async function updatePulseResponseNotionId(id, notionRowId) {
  await pool.query(
    `UPDATE pulse_responses SET notion_row_id = $1 WHERE id = $2`,
    [notionRowId, id]
  );
}
async function getPulseResponseByUser(campaign_id, slack_user_id) {
  const { rows } = await pool.query(
    `SELECT * FROM pulse_responses WHERE campaign_id = $1 AND slack_user_id = $2 ORDER BY started_at DESC LIMIT 1`,
    [campaign_id, slack_user_id]
  );
  if (!rows[0]) return null;
  return { ...rows[0], answers: JSON.parse(rows[0].answers) };
}
async function countCompletedPulseResponses(campaign_id) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM pulse_responses WHERE campaign_id = $1 AND completed_at IS NOT NULL`,
    [campaign_id]
  );
  return { rows };
}
async function getRecentPulseCampaigns(sender_slack_id, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM pulse_campaigns WHERE sender_slack_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [sender_slack_id, limit]
  );
  return rows.map(r => ({ ...r, resolved_users: JSON.parse(r.resolved_users), questions: JSON.parse(r.questions) }));
}
async function getAllPulseResponses(campaign_id) {
  const { rows } = await pool.query(
    `SELECT * FROM pulse_responses WHERE campaign_id = $1 ORDER BY started_at ASC`,
    [campaign_id]
  );
  return rows.map(r => ({ ...r, answers: JSON.parse(r.answers) }));
}
// ============================================================
//  Pulse State
// ============================================================
async function createPulseState({ id, campaign_id, slack_user_id, dm_ts, dm_channel }) {
  await pool.query(
    `INSERT INTO pulse_state (id, campaign_id, slack_user_id, dm_ts, dm_channel)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (campaign_id, slack_user_id) DO UPDATE
       SET dm_ts = $4, dm_channel = $5, current_question_index = 0`,
    [id, campaign_id, slack_user_id, dm_ts || null, dm_channel || null]
  );
}
async function getPulseState(campaign_id, slack_user_id) {
  const { rows } = await pool.query(
    `SELECT * FROM pulse_state WHERE campaign_id = $1 AND slack_user_id = $2`,
    [campaign_id, slack_user_id]
  );
  return rows[0] || null;
}
async function updatePulseStateQuestion(campaign_id, slack_user_id, question_index) {
  await pool.query(
    `UPDATE pulse_state SET current_question_index = $1
     WHERE campaign_id = $2 AND slack_user_id = $3`,
    [question_index, campaign_id, slack_user_id]
  );
}
async function deletePulseState(campaign_id, slack_user_id) {
  await pool.query(
    `DELETE FROM pulse_state WHERE campaign_id = $1 AND slack_user_id = $2`,
    [campaign_id, slack_user_id]
  );
}
// ============================================================
//  Scheduled Posts
// ============================================================
async function createScheduledPost({ type, created_by, payload, scheduled_at }) {
  const res = await pool.query(
    `INSERT INTO scheduled_posts (type, created_by, payload, scheduled_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [type, created_by, JSON.stringify(payload), scheduled_at]
  );
  return res.rows[0].id;
}

// Atomic claim — grabs all due posts in one UPDATE so concurrent workers can't double-send
async function claimDuePosts() {
  const now = Math.floor(Date.now() / 1000);
  const res = await pool.query(
    `UPDATE scheduled_posts
     SET status = 'claimed'
     WHERE status = 'pending'
       AND scheduled_at <= $1
     RETURNING *`,
    [now]
  );
  return res.rows;
}

async function markPostSent({ id }) {
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `UPDATE scheduled_posts SET status = 'sent', sent_at = $1 WHERE id = $2`,
    [now, id]
  );
}

async function cancelScheduledPost({ id }) {
  await pool.query(
    `UPDATE scheduled_posts SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`,
    [id]
  );
}

async function getScheduledPostsByUser({ user_id }) {
  const res = await pool.query(
    `SELECT * FROM scheduled_posts
     WHERE created_by = $1
     ORDER BY scheduled_at ASC`,
    [user_id]
  );
  return res.rows;
}
// ============================================================
//  Exports
// ============================================================
module.exports = {
  storeDmTs,
  getRecipient,
  createAnnouncement,
  updateRecipientCount,
  getAnnouncement,
  getRecentAnnouncements,
  addRecipients,
  markRead,
  getRecipientStats,
  getPendingReaders,
  getAllReaders,
  saveGroup,
  getGroups,
  getGroup,
  deleteGroup,
  // Pulse
  createPulseCampaign,
  getPulseCampaign,
  updatePulseCampaignNotionId,
  storePulseChannelPost,
  createPulseResponse,
  getPulseResponse,
  getPulseResponseByUser,
  updatePulseResponseAnswers,
  completePulseResponse,
  updatePulseResponseNotionId,
  countCompletedPulseResponses,
  createPulseState,
  getPulseState,
  updatePulseStateQuestion,
  deletePulseState,
  getRecentPulseCampaigns,
  getAllPulseResponses,
  // Scheduled Posts
  createScheduledPost,
  claimDuePosts,
  markPostSent,
  cancelScheduledPost,
  getScheduledPostsByUser,
};
