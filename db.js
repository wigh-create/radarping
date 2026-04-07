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
};
