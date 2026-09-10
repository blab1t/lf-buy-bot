const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const transcripts = require('./transcripts');

// Nightly snapshot of everything that could not be rebuilt from Discord alone:
// the database, the listing/ticket tables as JSON, and the text of every open
// ticket channel. Older snapshots are pruned so the Pi does not fill up.
const ROOT = path.join(__dirname, '..', '..', 'backups');
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '2', 10));

function guildKey() {
  return String(config.GUILD_ID || 'unknown');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function listSnapshots() {
  const dir = path.join(ROOT, guildKey());
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort()
    .map((name) => ({ name, dir: path.join(dir, name) }));
}

function prune(keep = KEEP) {
  const snapshots = listSnapshots();
  const remove = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const snapshot of remove) {
    fs.rmSync(snapshot.dir, { recursive: true, force: true });
  }
  return remove.length;
}

// Copies the SQLite file safely (better-sqlite3 exposes a backup helper).
async function copyDatabase(targetDir) {
  try {
    await db.db.backup(path.join(targetDir, 'database.sqlite'));
    return true;
  } catch (err) {
    console.error('Database backup failed:', err.message);
    return false;
  }
}

function writeJson(targetDir, name, value) {
  fs.writeFileSync(path.join(targetDir, name), JSON.stringify(value, null, 2), 'utf8');
}

// Saves the readable text of every open ticket so conversations survive even if
// the server disappears before the tickets are closed.
async function saveTicketTexts(client, targetDir, { limit = 200 } = {}) {
  const dir = path.join(targetDir, 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  let saved = 0;
  for (const ticket of db.openTickets().slice(0, limit)) {
    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || typeof channel.messages?.fetch !== 'function') continue;
    const messages = await transcripts.fetchAllMessages(channel, 1000).catch(() => []);
    if (!messages.length) continue;
    const safe = `${String(ticket.number).padStart(4, '0')}-${channel.name}`.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80);
    fs.writeFileSync(path.join(dir, `${safe}.txt`), transcripts.renderText(channel, messages, ticket), 'utf8');
    saved += 1;
  }
  return saved;
}

async function run(client, { withTickets = true } = {}) {
  const startedAt = Date.now();
  const targetDir = path.join(ROOT, guildKey(), stamp());
  fs.mkdirSync(targetDir, { recursive: true });

  const listings = db.listingsForOrganization().map((row) => db.parseListing(row));
  const tickets = db.openTickets();
  writeJson(targetDir, 'listings.json', listings);
  writeJson(targetDir, 'tickets.json', tickets);
  writeJson(targetDir, 'settings.json', Object.fromEntries(
    db.db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value])
  ));
  writeJson(targetDir, 'invites.json', db.invitePairs({ limit: 5000 }));
  const dbCopied = await copyDatabase(targetDir);
  const ticketFiles = withTickets ? await saveTicketTexts(client, targetDir) : 0;

  const meta = {
    guildId: config.GUILD_ID,
    createdAt: new Date().toISOString(),
    listings: listings.length,
    openTickets: tickets.length,
    ticketTranscripts: ticketFiles,
    databaseCopied: dbCopied,
    tookMs: Date.now() - startedAt,
  };
  writeJson(targetDir, 'meta.json', meta);
  const pruned = prune();
  console.log(`Backup written to ${targetDir} (${listings.length} listings, ${ticketFiles} ticket transcripts, pruned ${pruned}).`);
  return { ...meta, dir: targetDir, pruned };
}

// Fires at the next local midnight, then every 24 hours.
function scheduleNightly(client) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const delay = next.getTime() - now.getTime();
  setTimeout(() => {
    run(client).catch((err) => console.error('Nightly backup failed:', err.message));
    setInterval(() => {
      run(client).catch((err) => console.error('Nightly backup failed:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`Nightly backup scheduled in ${Math.round(delay / 60000)} minutes (keeping ${KEEP}).`);
}

module.exports = { run, prune, listSnapshots, scheduleNightly, ROOT, KEEP };
