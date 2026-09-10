const config = require('../config');
const db = require('../db');
const linkdb = require('./linkdb');
const listings = require('./listings');
const setup = require('./setup');

function snapshotOf(listing) {
  return {
    status: listing.status,
    co: listing.co,
    bin: listing.bin,
    ign_hidden: Boolean(listing.ign_hidden),
    hide_proxy_label: Boolean(listing.hide_proxy_label),
    info: listing.info,
    capes: listing.capes,
  };
}

// Records a listing change so linked servers can mirror it, and keeps the shared
// account registry current so linked servers can offer it as a template.
// No-ops when the listing has no UUID (can't be matched across servers).
function emitListingUpdate(listingRow) {
  try {
    const listing = db.parseListing(listingRow);
    if (!listing) return;
    // Mirror to the external Angels API (no-op when no key is configured).
    require('./angels').syncListing(listing).catch(() => {});
    if (!listing.uuid) return;
    if (listing.status === 'deleted') linkdb.removeAccount(config.GUILD_ID, listing.uuid);
    else {
      linkdb.upsertAccount(config.GUILD_ID, listing.uuid, listing.ign, JSON.stringify({
        ...snapshotOf(listing),
        ign: listing.ign,
        category: listing.category,
        name_suggestion: listing.name_suggestion,
      }));
    }
    if (!linkdb.linkedGuilds(config.GUILD_ID).length) return;
    linkdb.addEvent(config.GUILD_ID, listing.uuid, JSON.stringify(snapshotOf(listing)));
  } catch (err) {
    console.error('Sync emit failed:', err.message);
  }
}

// Finds an existing listing for this account on any linked server, so a new
// proxy can be prefilled from it.
function findTemplate(uuid) {
  if (!uuid) return null;
  const linked = new Set(linkdb.linkedGuilds(config.GUILD_ID));
  if (!linked.size) return null;
  for (const row of linkdb.accountsByUuid(uuid)) {
    if (row.guild === config.GUILD_ID || !linked.has(row.guild)) continue;
    try {
      return { guild: row.guild, ign: row.ign, updatedAt: row.updated_at, data: JSON.parse(row.data) };
    } catch (err) {
      // malformed registry row, try the next one
    }
  }
  return null;
}

// Pushes every local proxied account to linked servers, e.g. right after a link
// is created so both sides converge on the current state.
function pushAllLocal() {
  let count = 0;
  for (const row of db.listingsWithUuid()) {
    emitListingUpdate(row);
    count += 1;
  }
  return count;
}

function sameSnapshot(current, snap) {
  return current.status === snap.status
    && current.co === snap.co
    && current.bin === snap.bin
    && Boolean(current.ign_hidden) === Boolean(snap.ign_hidden)
    && Boolean(current.hide_proxy_label) === Boolean(snap.hide_proxy_label)
    && JSON.stringify(current.info) === JSON.stringify(snap.info)
    && JSON.stringify(current.capes) === JSON.stringify(snap.capes);
}

// Applies a linked server's snapshot to the local listing for the same account.
// This path never emits, so linked servers cannot ping-pong updates.
async function applySnapshot(client, uuid, snap) {
  const row = db.findListingByUuid(uuid);
  if (!row) return;
  const current = db.parseListing(row);
  if (sameSnapshot(current, snap)) return;

  if (snap.status === 'deleted') {
    if (current.listing_channel_id) {
      const channel = await client.channels.fetch(current.listing_channel_id).catch(() => null);
      if (channel) await channel.delete('Synced deletion from a linked server').catch(() => {});
    }
    db.updateListing(current.id, { status: 'deleted' });
    return;
  }

  const fields = {
    co: snap.co,
    bin: snap.bin,
    info: snap.info,
    capes: snap.capes,
    ign_hidden: snap.ign_hidden ? 1 : 0,
    hide_proxy_label: snap.hide_proxy_label ? 1 : 0,
  };
  // Only settled states travel between servers. A restore ("published") undoes
  // a sale on every linked server, while pre-publication states (pending,
  // accepted) stay local so a half-finished listing cannot downgrade a live one.
  // A local listing with no channel is still in review here: adopting a remote
  // "published" would strand it with no card and no Accept button.
  if ((snap.status === 'published' || snap.status === 'sold') && current.listing_channel_id) fields.status = snap.status;
  const updated = db.updateListing(current.id, fields);
  // Price changes made on another server get the same announcement here, so
  // every server's listing channel shows the same C/O and BIN history.
  if (current.listing_channel_id) {
    if (snap.co !== current.co) {
      await listings.announceListingUpdate(client, updated, `Current offer: **${listings.displayUsdPrice(snap.co)}**`).catch(() => {});
      await listings.notifyWatchers(client, updated, `current offer is now **${listings.displayUsdPrice(snap.co)}**.`).catch(() => {});
      await listings.notifyOutbid(client, updated, snap.co).catch(() => {});
    }
    if (snap.bin !== current.bin) {
      const verb = listings.priceChangeVerb(current.bin, snap.bin);
      await listings.announceListingUpdate(client, updated, `Bin ${verb} to **${listings.displayUsdPrice(snap.bin)}**`).catch(() => {});
      await listings.notifyWatchers(client, updated, `BIN ${verb} to **${listings.displayUsdPrice(snap.bin)}**.`).catch(() => {});
    }
  }
  await listings.renderPublished(client, updated).catch(() => {});
  await listings.renderPreview(client, updated).catch(() => {});
  if (snap.status === 'sold' || snap.status === 'published') {
    const guild = await client.guilds.fetch(config.GUILD_ID).catch(() => null);
    if (guild) await setup.organizeListing(guild, db.getListing(current.id)).catch(() => {});
  }
}

async function poll(client) {
  const me = config.GUILD_ID;
  const linked = new Set(linkdb.linkedGuilds(me));
  const events = linkdb.eventsAfter(linkdb.getCursor(me));
  for (const event of events) {
    try {
      if (event.source_guild !== me && linked.has(event.source_guild)) {
        await applySnapshot(client, event.uuid, JSON.parse(event.snapshot));
      }
    } catch (err) {
      console.error('Sync apply failed:', err.message);
    }
    linkdb.setCursor(me, event.id);
  }
  // Keep the shared log from growing without bound.
  linkdb.pruneEvents(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

module.exports = {
  emitListingUpdate, pushAllLocal, poll, snapshotOf, findTemplate, applySnapshot,
  link: linkdb.link, unlink: linkdb.unlink, linkedGuilds: linkdb.linkedGuilds, directLinks: linkdb.directLinks,
};
