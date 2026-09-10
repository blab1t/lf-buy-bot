// A single SQLite file shared by every bot instance on this machine. It holds
// the server links and a sync-event log so the otherwise-isolated per-server
// databases can mirror listing changes for the same Minecraft account (UUID).
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = process.env.LINK_DB_PATH || path.join(__dirname, '..', '..', 'data', 'link.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // wait out writes from the other instances

db.exec(`
CREATE TABLE IF NOT EXISTS links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_guild TEXT NOT NULL,
  uuid TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_cursor (
  guild TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_registry (
  guild TEXT NOT NULL,
  uuid TEXT NOT NULL,
  ign TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild, uuid)
);
CREATE INDEX IF NOT EXISTS idx_registry_uuid ON account_registry (uuid);
`);

const linkStmt = db.prepare('INSERT OR IGNORE INTO links (a, b, created_at) VALUES (?, ?, ?)');
function link(g1, g2) {
  const now = Date.now();
  linkStmt.run(g1, g2, now);
  linkStmt.run(g2, g1, now);
}
function unlink(g1, g2) {
  db.prepare('DELETE FROM links WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(g1, g2, g2, g1);
}
function directLinks(guild) {
  return db.prepare('SELECT b FROM links WHERE a = ?').all(guild).map((row) => row.b);
}

// Links form a network: linking A-B and B-C puts A, B and C in one group, so
// every server in the group syncs with every other one.
function linkedGuilds(guild) {
  const seen = new Set([guild]);
  const queue = [guild];
  while (queue.length) {
    for (const next of directLinks(queue.shift())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  seen.delete(guild);
  return [...seen];
}

function upsertAccount(guild, uuid, ign, data) {
  db.prepare(`
    INSERT INTO account_registry (guild, uuid, ign, data, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild, uuid) DO UPDATE SET ign = excluded.ign, data = excluded.data, updated_at = excluded.updated_at
  `).run(guild, uuid, ign, data, Date.now());
}
function removeAccount(guild, uuid) {
  db.prepare('DELETE FROM account_registry WHERE guild = ? AND uuid = ?').run(guild, uuid);
}
function accountsByUuid(uuid) {
  return db.prepare('SELECT * FROM account_registry WHERE uuid = ? ORDER BY updated_at DESC').all(uuid);
}

function addEvent(sourceGuild, uuid, snapshot) {
  db.prepare('INSERT INTO sync_events (source_guild, uuid, snapshot, created_at) VALUES (?, ?, ?, ?)')
    .run(sourceGuild, uuid, snapshot, Date.now());
}
function eventsAfter(id, limit = 500) {
  return db.prepare('SELECT * FROM sync_events WHERE id > ? ORDER BY id ASC LIMIT ?').all(id, limit);
}
function pruneEvents(before) {
  db.prepare('DELETE FROM sync_events WHERE created_at < ?').run(before);
}

function getCursor(guild) {
  const row = db.prepare('SELECT last_id FROM sync_cursor WHERE guild = ?').get(guild);
  return row ? row.last_id : 0;
}
function setCursor(guild, id) {
  db.prepare('INSERT INTO sync_cursor (guild, last_id) VALUES (?, ?) ON CONFLICT(guild) DO UPDATE SET last_id = excluded.last_id')
    .run(guild, id);
}

module.exports = {
  link, unlink, linkedGuilds, directLinks, addEvent, eventsAfter, pruneEvents, getCursor, setCursor,
  upsertAccount, removeAccount, accountsByUuid,
};
