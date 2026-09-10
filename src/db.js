const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { DB_PATH } = require('./config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  listing_id INTEGER,
  offer_amount TEXT,
  offer_status TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
-- A ticket channel can host several things at once: two proxies, an offer and a
-- BIN, and so on. Each of those is a row here. The columns on the tickets table
-- still describe the item the channel was originally opened for (its name,
-- category and close behaviour derive from that); the rest live only here.
CREATE TABLE IF NOT EXISTS ticket_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  listing_id INTEGER,
  offer_amount TEXT,
  offer_status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_items_ticket ON ticket_items (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_items_listing ON ticket_items (listing_id);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ign TEXT NOT NULL,
  uuid TEXT,
  category TEXT NOT NULL,
  capes TEXT NOT NULL DEFAULT '[]',
  info TEXT NOT NULL DEFAULT '{}',
  co TEXT NOT NULL DEFAULT 'Offer',
  bin TEXT NOT NULL DEFAULT 'Offer',
  status TEXT NOT NULL DEFAULT 'pending',
  requester_id TEXT NOT NULL,
  ticket_channel_id TEXT,
  preview_message_id TEXT,
  listing_channel_id TEXT,
  listing_message_id TEXT,
  name_suggestion TEXT,
  ign_hidden INTEGER NOT NULL DEFAULT 0,
  hide_proxy_label INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proxy_categories (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_deletes (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  delete_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_closes (
  channel_id TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  prompt_message_id TEXT,
  close_at INTEGER NOT NULL,
  forced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inactivity_watch (
  channel_id TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  silent INTEGER NOT NULL DEFAULT 1,
  armed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vouch_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vouch_mentions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_vouch_mentions_user ON vouch_mentions (user_id);
CREATE TABLE IF NOT EXISTS listing_watchers (
  listing_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (listing_id, user_id)
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, coin)
);
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  winners INTEGER NOT NULL DEFAULT 1,
  host_id TEXT NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winner_ids TEXT,
  required_role_id TEXT,
  min_invites INTEGER NOT NULL DEFAULT 0,
  goal_invites INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  inviter_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invited_members (
  member_id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_invited_inviter ON invited_members (inviter_id);
CREATE TABLE IF NOT EXISTS ping_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  label TEXT NOT NULL,
  emoji TEXT,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Migration for databases created before name_suggestion existed.
try {
  db.exec('ALTER TABLE listings ADD COLUMN name_suggestion TEXT');
} catch (err) {
  // column already exists
}
try {
  db.exec('ALTER TABLE listings ADD COLUMN ign_hidden INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  // column already exists
}
try {
  db.exec('ALTER TABLE listings ADD COLUMN hide_proxy_label INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  // column already exists
}
try {
  db.exec('ALTER TABLE tickets ADD COLUMN offer_amount TEXT');
} catch (err) {
  // column already exists
}
try {
  db.exec('ALTER TABLE tickets ADD COLUMN offer_status TEXT');
} catch (err) {
  // column already exists
}
// giveaways gained invite/role requirements after its first release.
for (const migration of [
  'ALTER TABLE giveaways ADD COLUMN required_role_id TEXT',
  'ALTER TABLE giveaways ADD COLUMN min_invites INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE giveaways ADD COLUMN goal_invites INTEGER',
  // Manually-added vouches (e.g. a screenshot or a vouch that forgot to ping).
  'ALTER TABLE vouch_messages ADD COLUMN manual INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE vouch_messages ADD COLUMN voucher_id TEXT',
  // Forced closes cannot be cancelled by the creator or by new messages.
  'ALTER TABLE pending_closes ADD COLUMN forced INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE pending_closes ADD COLUMN keep_listing INTEGER NOT NULL DEFAULT 0',
  // What an inactivity watch does when its window runs out, and how long the
  // resulting close prompt waits.
  "ALTER TABLE inactivity_watch ADD COLUMN action TEXT NOT NULL DEFAULT 'request'",
  'ALTER TABLE inactivity_watch ADD COLUMN close_ms INTEGER',
]) {
  try {
    db.exec(migration);
  } catch (err) {
    // column already exists
  }
}

// --- settings ---
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const delSettingStmt = db.prepare('DELETE FROM settings WHERE key = ?');

function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}
function delSetting(key) {
  delSettingStmt.run(key);
}

// Every ticket that already carried a listing or an offer becomes its own first
// ticket_items row, so the new multi-item reads see the whole history.
if (!getSetting('ticket_items_backfilled')) {
  db.prepare(`
    INSERT INTO ticket_items (ticket_id, kind, listing_id, offer_amount, offer_status, created_at)
    SELECT id, type, listing_id, offer_amount, offer_status, created_at FROM tickets
    WHERE listing_id IS NOT NULL OR offer_amount IS NOT NULL
  `).run();
  setSetting('ticket_items_backfilled', '1');
}

const nextTicketNumber = db.transaction(() => {
  const current = parseInt(getSetting('ticket_seq') || '0', 10) + 1;
  setSetting('ticket_seq', current);
  return current;
});

function getVouchCount() {
  return parseInt(getSetting('vouch_count') || '0', 10);
}
function setVouchCount(n) {
  setSetting('vouch_count', n);
}
function recordVouchMessage(messageId, channelId, createdAt = Date.now()) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO vouch_messages (message_id, channel_id, created_at) VALUES (?, ?, ?)
  `).run(messageId, channelId, createdAt);
  return result.changes === 1;
}
function recordVouchMentions(messageId, userIds) {
  const ids = [...new Set(userIds || [])].filter(Boolean);
  const insert = db.prepare('INSERT OR IGNORE INTO vouch_mentions (message_id, user_id) VALUES (?, ?)');
  const transaction = db.transaction((values) => {
    for (const userId of values) insert.run(messageId, userId);
  });
  transaction(ids);
}
const removeVouchMessage = db.transaction((messageId) => {
  const row = db.prepare('SELECT message_id, channel_id FROM vouch_messages WHERE message_id = ?').get(messageId);
  if (!row) return null;
  db.prepare('DELETE FROM vouch_mentions WHERE message_id = ?').run(messageId);
  db.prepare('DELETE FROM vouch_messages WHERE message_id = ?').run(messageId);
  return row;
});
function countVouchMessages(channelId) {
  return db.prepare('SELECT COUNT(*) AS count FROM vouch_messages WHERE channel_id = ?').get(channelId).count;
}
const replaceVouchMessages = db.transaction((channelId, messages) => {
  // Only clear auto-scanned rows; manually-added vouches are preserved because
  // their source message may not be re-detectable (screenshots, no ping).
  db.prepare(`
    DELETE FROM vouch_mentions
    WHERE message_id IN (SELECT message_id FROM vouch_messages WHERE channel_id = ? AND manual = 0)
  `).run(channelId);
  db.prepare('DELETE FROM vouch_messages WHERE channel_id = ? AND manual = 0').run(channelId);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO vouch_messages (message_id, channel_id, created_at) VALUES (?, ?, ?)
  `);
  const insertMention = db.prepare('INSERT OR IGNORE INTO vouch_mentions (message_id, user_id) VALUES (?, ?)');
  for (const message of messages) {
    insert.run(message.id, channelId, message.createdTimestamp || Date.now());
    for (const userId of [...new Set(message.userIds || [])].filter(Boolean)) insertMention.run(message.id, userId);
  }
  const total = countVouchMessages(channelId);
  setSetting('vouch_count', total);
  setSetting('vouch_count_channel', channelId);
  return total;
});
// Records a vouch staff added by hand. Returns { added: true } when it created a
// new vouch, or { added: false } when the linked message was already a vouch (in
// which case only the recipient credit is ensured, never a double count).
const addManualVouch = db.transaction((messageId, channelId, voucherId, recipientId, createdAt) => {
  const existing = db.prepare('SELECT message_id FROM vouch_messages WHERE message_id = ?').get(messageId);
  let added = false;
  if (!existing) {
    db.prepare('INSERT INTO vouch_messages (message_id, channel_id, created_at, manual, voucher_id) VALUES (?, ?, ?, 1, ?)')
      .run(messageId, channelId, createdAt, voucherId || null);
    added = true;
  } else if (voucherId) {
    db.prepare('UPDATE vouch_messages SET voucher_id = COALESCE(voucher_id, ?) WHERE message_id = ?').run(voucherId, messageId);
  }
  if (recipientId) {
    db.prepare('INSERT OR IGNORE INTO vouch_mentions (message_id, user_id) VALUES (?, ?)').run(messageId, String(recipientId));
  }
  return { added };
});
function getVouchLeaderboard(limit = 1000) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 1000));
  return db.prepare(`
    SELECT user_id, COUNT(*) AS count
    FROM vouch_mentions
    GROUP BY user_id
    ORDER BY count DESC, user_id ASC
    LIMIT ?
  `).all(safeLimit);
}

// --- tickets ---
const insertTicketStmt = db.prepare(`
  INSERT INTO tickets (number, channel_id, type, creator_id, listing_id, offer_amount, offer_status, created_at)
  VALUES (@number, @channel_id, @type, @creator_id, @listing_id, @offer_amount, @offer_status, @created_at)
`);
const insertTicketItemStmt = db.prepare(`
  INSERT INTO ticket_items (ticket_id, kind, listing_id, offer_amount, offer_status, created_at)
  VALUES (@ticket_id, @kind, @listing_id, @offer_amount, @offer_status, @created_at)
`);
const createTicket = db.transaction(({ number, channelId, type, creatorId, listingId = null, offerAmount = null, offerStatus = null }) => {
  const now = Date.now();
  const result = insertTicketStmt.run({
    number,
    channel_id: channelId,
    type,
    creator_id: creatorId,
    listing_id: listingId,
    offer_amount: offerAmount,
    offer_status: offerStatus,
    created_at: now,
  });
  // The thing the channel was opened for is also its first item.
  if (listingId || offerAmount) {
    insertTicketItemStmt.run({
      ticket_id: result.lastInsertRowid,
      kind: type,
      listing_id: listingId,
      offer_amount: offerAmount,
      offer_status: offerStatus,
      created_at: now,
    });
  }
  return getTicket(result.lastInsertRowid);
});
function getTicket(id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}
function getTicketByChannel(channelId) {
  return db
    .prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'")
    .get(channelId);
}
function getTicketByAnyChannel(channelId) {
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(channelId);
}
function findOpenTicket(type, creatorId, listingId) {
  return db
    .prepare(
      "SELECT * FROM tickets WHERE type = ? AND creator_id = ? AND listing_id IS ? AND status = 'open'"
    )
    .get(type, creatorId, listingId);
}
function markTicketClosed(id) {
  db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
}
// Free-text lookup across listings: username, UUID or channel id.
function searchListings(term, limit = 15) {
  const like = `%${String(term || '').trim()}%`;
  return db.prepare(`
    SELECT * FROM listings
    WHERE status != 'deleted'
      AND (ign LIKE ? COLLATE NOCASE OR uuid = ? OR listing_channel_id = ? OR ticket_channel_id = ?)
    ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'accepted' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, id DESC
    LIMIT ?
  `).all(like, term, term, term, limit);
}
function searchTickets({ term = null, number = null, creatorId = null, limit = 15 }) {
  return db.prepare(`
    SELECT * FROM tickets
    WHERE (? IS NULL OR number = ?)
      AND (? IS NULL OR channel_id = ?)
      AND (? IS NULL OR creator_id = ?)
    ORDER BY status = 'open' DESC, number DESC
    LIMIT ?
  `).all(number, number, term, term, creatorId, creatorId, limit);
}
function listingsForRequester(userId, limit = 15) {
  return db.prepare(`
    SELECT * FROM listings WHERE requester_id = ? AND status != 'deleted' ORDER BY id DESC LIMIT ?
  `).all(String(userId), limit);
}
function openTickets() {
  return db.prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY number ASC").all();
}
// --- ticket items ---
// Item rows are read joined with their ticket and deliberately keep the field
// names of a ticket row (`id`, `channel_id`, `creator_id`, `status`), so call
// sites that used to read a one-offer-per-ticket row work unchanged. `item_id`
// is the handle for anything that writes back to the item itself.
const ITEM_SELECT = `
  SELECT ti.id AS item_id, ti.kind, ti.listing_id, ti.offer_amount, ti.offer_status,
         ti.created_at AS item_created_at,
         t.id AS id, t.number, t.channel_id, t.creator_id, t.status, t.type
  FROM ticket_items ti JOIN tickets t ON t.id = ti.ticket_id
`;
function addTicketItem({ ticketId, kind, listingId = null, offerAmount = null, offerStatus = null }) {
  const result = insertTicketItemStmt.run({
    ticket_id: ticketId,
    kind,
    listing_id: listingId,
    offer_amount: offerAmount,
    offer_status: offerStatus,
    created_at: Date.now(),
  });
  return getTicketItem(result.lastInsertRowid);
}
function getTicketItem(itemId) {
  return db.prepare(`${ITEM_SELECT} WHERE ti.id = ?`).get(itemId);
}
function ticketItems(ticketId) {
  return db.prepare(`${ITEM_SELECT} WHERE ti.ticket_id = ? ORDER BY ti.id ASC`).all(ticketId);
}
function firstTicketItem(ticketId) {
  return db.prepare(`${ITEM_SELECT} WHERE ti.ticket_id = ? ORDER BY ti.id ASC LIMIT 1`).get(ticketId);
}
function offerTicketsForListing(listingId) {
  return db.prepare(`${ITEM_SELECT}
    WHERE ti.listing_id = ? AND ti.kind = 'offer' AND ti.offer_amount IS NOT NULL
    ORDER BY ti.id DESC`).all(listingId);
}
function findOfferTicket(listingId, creatorId) {
  return db.prepare(`${ITEM_SELECT}
    WHERE ti.listing_id = ? AND t.creator_id = ? AND ti.kind = 'offer' AND ti.offer_amount IS NOT NULL
    ORDER BY ti.id DESC LIMIT 1`).get(listingId, String(creatorId));
}
// The user's live item of this kind on this listing, wherever it is parked.
function findOpenTicketItem(kind, listingId, creatorId) {
  return db.prepare(`${ITEM_SELECT}
    WHERE ti.kind = ? AND ti.listing_id = ? AND t.creator_id = ? AND t.status = 'open'
    ORDER BY ti.id DESC LIMIT 1`).get(kind, listingId, String(creatorId));
}
// Buttons posted before ticket_items existed carry a ticket id, not an item id.
function pendingOfferItemForTicket(ticketId, listingId) {
  return db.prepare(`${ITEM_SELECT}
    WHERE ti.ticket_id = ? AND ti.listing_id = ? AND ti.kind = 'offer' AND ti.offer_status = 'pending'
    ORDER BY ti.id ASC LIMIT 1`).get(ticketId, listingId);
}
// Every open ticket this user could park something new on.
function openTicketsForUser(userId, limit = 24) {
  return db.prepare(`
    SELECT * FROM tickets WHERE creator_id = ? AND status = 'open' ORDER BY number DESC LIMIT ?
  `).all(String(userId), limit);
}
// Adds a proxy to a ticket. The first item on an otherwise empty ticket also
// becomes the ticket's own listing, which is what drives its name and its close
// behaviour; later ones only ever live in ticket_items.
const attachListingToTicket = db.transaction((ticketId, listingId, kind = 'proxy') => {
  const ticket = getTicket(ticketId);
  const primary = Boolean(ticket) && !ticket.listing_id && ticketItems(ticketId).length === 0;
  if (primary) {
    db.prepare("UPDATE tickets SET listing_id = ?, type = 'proxy' WHERE id = ?").run(listingId, ticketId);
  }
  insertTicketItemStmt.run({
    ticket_id: ticketId, kind, listing_id: listingId,
    offer_amount: null, offer_status: null, created_at: Date.now(),
  });
  return { ticket: getTicket(ticketId), primary };
});
// Reuses an existing offer for a new amount: re-opens its ticket if it was
// closed, so buyers do not collect a channel per offer.
function reviveOfferItem(itemId, amount, status = 'pending') {
  db.prepare('UPDATE ticket_items SET offer_amount = ?, offer_status = ? WHERE id = ?')
    .run(amount, status, itemId);
  const item = getTicketItem(itemId);
  if (item) db.prepare("UPDATE tickets SET status = 'open' WHERE id = ?").run(item.id);
  return getTicketItem(itemId);
}
function updateTicketItemOfferStatus(itemId, status) {
  db.prepare('UPDATE ticket_items SET offer_status = ? WHERE id = ?').run(status, itemId);
  return getTicketItem(itemId);
}

// --- listings ---
const LISTING_COLUMNS = [
  'ign', 'uuid', 'category', 'capes', 'info', 'co', 'bin', 'status',
  'ticket_channel_id', 'preview_message_id', 'listing_channel_id', 'listing_message_id',
  'name_suggestion', 'ign_hidden', 'hide_proxy_label',
];
function createListing({
  ign, uuid, category, capes, info, co, bin, requesterId,
  nameSuggestion = null, ignHidden = false, hideProxyLabel = false,
}) {
  const result = db
    .prepare(`
      INSERT INTO listings (ign, uuid, category, capes, info, co, bin, requester_id, name_suggestion, ign_hidden, hide_proxy_label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      ign, uuid, category,
      JSON.stringify(capes || []),
      JSON.stringify(info || {}),
      co || 'Offer', bin || 'Offer',
      requesterId, nameSuggestion, ignHidden ? 1 : 0, hideProxyLabel ? 1 : 0, Date.now()
    );
  return getListing(result.lastInsertRowid);
}
function getListing(id) {
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
}
function findListingByIgn(ign) {
  return db
    .prepare(
      "SELECT * FROM listings WHERE ign = ? COLLATE NOCASE AND status != 'deleted' ORDER BY id DESC LIMIT 1"
    )
    .get(ign);
}
function findListingByUuid(uuid) {
  if (!uuid) return null;
  return db
    .prepare("SELECT * FROM listings WHERE uuid = ? AND status != 'deleted' ORDER BY id DESC LIMIT 1")
    .get(uuid);
}
// Every active listing for the same account, matched on UUID when available and
// otherwise on the username. Used to warn staff about double-proxied accounts.
function findDuplicateListings({ uuid = null, ign = null, excludeId = null }) {
  const rows = db.prepare(`
    SELECT * FROM listings
    WHERE status NOT IN ('deleted', 'denied', 'sold')
      AND ((? IS NOT NULL AND uuid = ?) OR (uuid IS NULL AND ign = ? COLLATE NOCASE))
    ORDER BY id ASC
  `).all(uuid, uuid, ign || '');
  return excludeId ? rows.filter((row) => row.id !== excludeId) : rows;
}
function listingsWithUuid() {
  return db.prepare("SELECT * FROM listings WHERE status != 'deleted' AND uuid IS NOT NULL AND uuid != ''").all();
}
function updateListing(id, fields) {
  const keys = Object.keys(fields).filter((k) => LISTING_COLUMNS.includes(k));
  if (!keys.length) return getListing(id);
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id };
  for (const key of keys) {
    const value = fields[key];
    params[key] = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
  }
  db.prepare(`UPDATE listings SET ${assignments} WHERE id = @id`).run(params);
  return getListing(id);
}
function parseListing(row) {
  if (!row) return null;
  return {
    ...row,
    ign_hidden: Boolean(row.ign_hidden),
    hide_proxy_label: Boolean(row.hide_proxy_label),
    capes: JSON.parse(row.capes || '[]'),
    info: JSON.parse(row.info || '{}'),
  };
}
// requester_id is intentionally outside the general updateListing whitelist so
// ownership only changes through the deliberate proxy reassign flow.
function setListingRequester(id, requesterId) {
  db.prepare('UPDATE listings SET requester_id = ? WHERE id = ?').run(String(requesterId), id);
  return getListing(id);
}

// --- proxy categories ---
function listCustomProxyCategories() {
  return db.prepare('SELECT key, label FROM proxy_categories ORDER BY label COLLATE NOCASE').all();
}
function addCustomProxyCategory(key, label) {
  db.prepare('INSERT INTO proxy_categories (key, label, created_at) VALUES (?, ?, ?)').run(key, label, Date.now());
}
function renameCustomProxyCategory(key, label) {
  return db.prepare('UPDATE proxy_categories SET label = ? WHERE key = ?').run(label, key).changes === 1;
}
function removeCustomProxyCategory(key) {
  return db.prepare('DELETE FROM proxy_categories WHERE key = ?').run(key).changes === 1;
}
function countListingsForCategory(key) {
  return db.prepare("SELECT COUNT(*) AS count FROM listings WHERE category = ? AND status != 'deleted'").get(key).count;
}
function listingsForOrganization() {
  return db.prepare(`
    SELECT * FROM listings
    WHERE status != 'deleted' AND (listing_channel_id IS NOT NULL OR ticket_channel_id IS NOT NULL)
  `).all();
}

// --- listing watchers ---
function addWatcher(listingId, userId) {
  return db.prepare('INSERT OR IGNORE INTO listing_watchers (listing_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(listingId, String(userId), Date.now()).changes === 1;
}
function removeWatcher(listingId, userId) {
  return db.prepare('DELETE FROM listing_watchers WHERE listing_id = ? AND user_id = ?')
    .run(listingId, String(userId)).changes === 1;
}
function isWatching(listingId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM listing_watchers WHERE listing_id = ? AND user_id = ?').get(listingId, String(userId)));
}
function watcherIds(listingId) {
  return db.prepare('SELECT user_id FROM listing_watchers WHERE listing_id = ?').all(listingId).map((row) => row.user_id);
}
function watcherCount(listingId) {
  return db.prepare('SELECT COUNT(*) AS count FROM listing_watchers WHERE listing_id = ?').get(listingId).count;
}
function clearWatchers(listingId) {
  db.prepare('DELETE FROM listing_watchers WHERE listing_id = ?').run(listingId);
}

// --- wallets ---
const setWalletStmt = db.prepare(`
  INSERT INTO wallets (user_id, coin, address, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, coin) DO UPDATE SET address = excluded.address, updated_at = excluded.updated_at
`);
function setWallet(userId, coin, address) {
  setWalletStmt.run(String(userId), String(coin), String(address), Date.now());
}
function getWallet(userId, coin) {
  return db.prepare('SELECT user_id, coin, address FROM wallets WHERE user_id = ? AND coin = ?').get(String(userId), String(coin));
}
function getWallets(userId) {
  return db.prepare('SELECT user_id, coin, address FROM wallets WHERE user_id = ? ORDER BY updated_at DESC').all(String(userId));
}
function deleteWallet(userId, coin) {
  return db.prepare('DELETE FROM wallets WHERE user_id = ? AND coin = ?').run(String(userId), String(coin)).changes === 1;
}

// --- giveaways ---
function createGiveaway({ channelId, prize, winners, hostId, endAt, requiredRoleId = null, minInvites = 0, goalInvites = null }) {
  const result = db.prepare(`
    INSERT INTO giveaways (channel_id, prize, winners, host_id, end_at, required_role_id, min_invites, goal_invites, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    channelId, prize, Math.max(1, winners || 1), hostId, endAt,
    requiredRoleId || null, Math.max(0, minInvites || 0), goalInvites || null, Date.now()
  );
  return getGiveaway(result.lastInsertRowid);
}
function goalGiveaways() {
  return db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND goal_invites IS NOT NULL").all();
}
function getGiveaway(id) {
  return db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
}
function getGiveawayByMessage(messageId) {
  return db.prepare('SELECT * FROM giveaways WHERE message_id = ? ORDER BY id DESC LIMIT 1').get(String(messageId));
}
function setGiveawayMessage(id, messageId) {
  db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(String(messageId), id);
  return getGiveaway(id);
}
function activeGiveaways() {
  return db.prepare("SELECT * FROM giveaways WHERE status = 'active' ORDER BY end_at ASC").all();
}
function dueGiveaways(now) {
  // end_at of 0 means the giveaway has no timer and only ends manually.
  return db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND end_at > 0 AND end_at <= ?").all(now);
}
function finishGiveaway(id, winnerIds, status = 'ended') {
  db.prepare('UPDATE giveaways SET status = ?, winner_ids = ? WHERE id = ?')
    .run(status, JSON.stringify(winnerIds || []), id);
  return getGiveaway(id);
}
function setGiveawayWinners(id, winnerIds) {
  db.prepare('UPDATE giveaways SET winner_ids = ? WHERE id = ?').run(JSON.stringify(winnerIds || []), id);
  return getGiveaway(id);
}
function addGiveawayEntry(giveawayId, userId) {
  return db.prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)')
    .run(giveawayId, String(userId)).changes === 1;
}
function removeGiveawayEntry(giveawayId, userId) {
  return db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?')
    .run(giveawayId, String(userId)).changes === 1;
}
function giveawayEntryIds(giveawayId) {
  return db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(giveawayId).map((r) => r.user_id);
}
function giveawayEntryCount(giveawayId) {
  return db.prepare('SELECT COUNT(*) AS count FROM giveaway_entries WHERE giveaway_id = ?').get(giveawayId).count;
}

// --- invites ---
const incrementInviteStmt = db.prepare(`
  INSERT INTO invites (inviter_id, count) VALUES (?, ?)
  ON CONFLICT(inviter_id) DO UPDATE SET count = MAX(0, count + excluded.count)
`);
function incrementInvite(inviterId, delta) {
  incrementInviteStmt.run(String(inviterId), delta);
}
function getInviteCount(inviterId) {
  const row = db.prepare('SELECT count FROM invites WHERE inviter_id = ?').get(String(inviterId));
  return row ? row.count : 0;
}
function inviteLeaderboard(limit = 10) {
  const safe = Math.max(1, Math.min(50, Number(limit) || 10));
  return db.prepare('SELECT inviter_id, count FROM invites WHERE count > 0 ORDER BY count DESC, inviter_id ASC LIMIT ?').all(safe);
}
function recordInvitedMember(memberId, inviterId, joinedAt) {
  db.prepare(`
    INSERT INTO invited_members (member_id, inviter_id, joined_at, active) VALUES (?, ?, ?, 1)
    ON CONFLICT(member_id) DO UPDATE SET inviter_id = excluded.inviter_id, joined_at = excluded.joined_at, active = 1
  `).run(String(memberId), String(inviterId), joinedAt);
}
function getInvitedMember(memberId) {
  return db.prepare('SELECT member_id, inviter_id, joined_at, active FROM invited_members WHERE member_id = ?').get(String(memberId));
}
function deactivateInvitedMember(memberId) {
  db.prepare('UPDATE invited_members SET active = 0 WHERE member_id = ?').run(String(memberId));
}
// Everyone a given member brought in, newest first.
function invitedMembersOf(inviterId, { includeLeft = true, limit = 100 } = {}) {
  return db.prepare(`
    SELECT member_id, inviter_id, joined_at, active FROM invited_members
    WHERE inviter_id = ? ${includeLeft ? '' : 'AND active = 1'}
    ORDER BY joined_at DESC LIMIT ?
  `).all(String(inviterId), limit);
}
// The full who-invited-whom list.
function invitePairs({ limit = 200 } = {}) {
  return db.prepare(`
    SELECT member_id, inviter_id, joined_at, active FROM invited_members
    ORDER BY joined_at DESC LIMIT ?
  `).all(limit);
}
function countInvitesSince(inviterId, sinceTs) {
  return db.prepare('SELECT COUNT(*) AS count FROM invited_members WHERE inviter_id = ? AND active = 1 AND joined_at >= ?')
    .get(String(inviterId), sinceTs).count;
}

// --- ping roles ---
const upsertPingRoleStmt = db.prepare(`
  INSERT INTO ping_roles (ref, label, emoji, role_id, created_at)
  VALUES (@ref, @label, @emoji, @role_id, @created_at)
  ON CONFLICT(ref) DO UPDATE SET label = excluded.label, emoji = excluded.emoji, role_id = excluded.role_id
`);
function upsertPingRole({ ref, label, emoji = null, roleId }) {
  upsertPingRoleStmt.run({ ref, label, emoji: emoji || null, role_id: String(roleId), created_at: Date.now() });
  return getPingRoleByRef(ref);
}
function getPingRole(id) {
  return db.prepare('SELECT * FROM ping_roles WHERE id = ?').get(id);
}
function getPingRoleByRef(ref) {
  return db.prepare('SELECT * FROM ping_roles WHERE ref = ?').get(ref);
}
function getPingRoleByRoleId(roleId) {
  return db.prepare('SELECT * FROM ping_roles WHERE role_id = ?').get(String(roleId));
}
function listPingRoles() {
  return db.prepare('SELECT * FROM ping_roles ORDER BY created_at ASC, id ASC').all();
}
function countPingRoles() {
  return db.prepare('SELECT COUNT(*) AS count FROM ping_roles').get().count;
}
function removePingRole(id) {
  return db.prepare('DELETE FROM ping_roles WHERE id = ?').run(id).changes === 1;
}

// --- pending deletes ---
function addPendingDelete(messageId, channelId, targetId, deleteAt) {
  db.prepare(`
    INSERT OR REPLACE INTO pending_deletes (message_id, channel_id, target_id, delete_at)
    VALUES (?, ?, ?, ?)
  `).run(messageId, channelId, targetId, deleteAt);
}
function duePendingDeletes(now) {
  return db.prepare('SELECT * FROM pending_deletes WHERE delete_at <= ?').all(now);
}
function pendingDeletesFor(channelId, targetId) {
  return db
    .prepare('SELECT * FROM pending_deletes WHERE channel_id = ? AND target_id = ?')
    .all(channelId, targetId);
}
function removePendingDelete(messageId) {
  db.prepare('DELETE FROM pending_deletes WHERE message_id = ?').run(messageId);
}

// --- inactivity watches ---
function setInactivityWatch({ channelId, ticketId, timeoutMs, lastActivity, silent = true, armedBy = null, action = 'request', closeMs = null }) {
  db.prepare(`
    INSERT OR REPLACE INTO inactivity_watch (channel_id, ticket_id, timeout_ms, last_activity, silent, armed_by, action, close_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(channelId), ticketId, timeoutMs, lastActivity, silent ? 1 : 0, armedBy, action, closeMs, Date.now());
  return getInactivityWatch(channelId);
}
function getInactivityWatch(channelId) {
  return db.prepare('SELECT * FROM inactivity_watch WHERE channel_id = ?').get(String(channelId));
}
function removeInactivityWatch(channelId) {
  return db.prepare('DELETE FROM inactivity_watch WHERE channel_id = ?').run(String(channelId)).changes === 1;
}
function allInactivityWatches() {
  return db.prepare('SELECT * FROM inactivity_watch ORDER BY last_activity ASC').all();
}
function dueInactivityWatches(now) {
  return db.prepare('SELECT * FROM inactivity_watch WHERE (last_activity + timeout_ms) <= ?').all(now);
}
// Any human message in the channel resets its inactivity countdown.
function touchInactivityWatch(channelId, when = Date.now()) {
  db.prepare('UPDATE inactivity_watch SET last_activity = ? WHERE channel_id = ?').run(when, String(channelId));
}

// --- pending closes ---
function upsertPendingClose(channelId, ticketId, promptMessageId, closeAt, forced = 0, keepListing = 0) {
  db.prepare(`
    INSERT OR REPLACE INTO pending_closes (channel_id, ticket_id, prompt_message_id, close_at, forced, keep_listing)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(channelId, ticketId, promptMessageId, closeAt, forced ? 1 : 0, keepListing ? 1 : 0);
}
function getPendingClose(channelId) {
  return db.prepare('SELECT * FROM pending_closes WHERE channel_id = ?').get(channelId);
}
function removePendingClose(channelId) {
  db.prepare('DELETE FROM pending_closes WHERE channel_id = ?').run(channelId);
}
function duePendingCloses(now) {
  return db.prepare('SELECT * FROM pending_closes WHERE close_at <= ?').all(now);
}

module.exports = {
  db,
  getSetting, setSetting, delSetting,
  nextTicketNumber, getVouchCount, setVouchCount, recordVouchMessage, recordVouchMentions, removeVouchMessage, countVouchMessages, replaceVouchMessages, getVouchLeaderboard, addManualVouch,
  createTicket, getTicket, getTicketByChannel, getTicketByAnyChannel, findOpenTicket, markTicketClosed, openTickets, searchListings, searchTickets, listingsForRequester,
  addTicketItem, getTicketItem, ticketItems, firstTicketItem, offerTicketsForListing, findOfferTicket,
  findOpenTicketItem, pendingOfferItemForTicket, openTicketsForUser, attachListingToTicket,
  reviveOfferItem, updateTicketItemOfferStatus,
  createListing, getListing, findListingByIgn, findListingByUuid, listingsWithUuid, findDuplicateListings, updateListing, parseListing, setListingRequester,
  listCustomProxyCategories, addCustomProxyCategory, renameCustomProxyCategory, removeCustomProxyCategory,
  countListingsForCategory, listingsForOrganization,
  setWallet, getWallet, getWallets, deleteWallet,
  addWatcher, removeWatcher, isWatching, watcherIds, watcherCount, clearWatchers,
  createGiveaway, getGiveaway, getGiveawayByMessage, setGiveawayMessage, activeGiveaways, dueGiveaways, goalGiveaways,
  finishGiveaway, setGiveawayWinners, addGiveawayEntry, removeGiveawayEntry, giveawayEntryIds, giveawayEntryCount,
  incrementInvite, getInviteCount, inviteLeaderboard, recordInvitedMember, getInvitedMember, deactivateInvitedMember, countInvitesSince,
  invitedMembersOf, invitePairs,
  upsertPingRole, getPingRole, getPingRoleByRef, getPingRoleByRoleId, listPingRoles, countPingRoles, removePingRole,
  addPendingDelete, duePendingDeletes, pendingDeletesFor, removePendingDelete,
  upsertPendingClose, getPendingClose, removePendingClose, duePendingCloses,
  setInactivityWatch, getInactivityWatch, removeInactivityWatch, allInactivityWatches, dueInactivityWatches, touchInactivityWatch,
};
