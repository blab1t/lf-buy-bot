const {
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const db = require('../db');
const config = require('../config');
const listings = require('./listings');
const tickets = require('./tickets');
const setup = require('./setup');
const channelPerms = require('./channelPerms');

// Disaster recovery. The database lives on the Pi, so if a server is lost the
// listings can be recreated on a fresh one: channels are rebuilt empty with
// only a Finish button, letting staff write the description themselves before
// the listing embed is posted.

function activeListings() {
  return db.listingsForOrganization()
    .map((row) => db.parseListing(row))
    .filter((listing) => listing.status === 'published' || listing.status === 'accepted' || listing.status === 'sold');
}

function channelNameFor(listing) {
  if (listing.ign_hidden) {
    return listing.category === 'minecon' ? listings.mineconChannelName(listing) : 'hidden';
  }
  if (listing.category === 'stat' && listing.name_suggestion) return listing.name_suggestion;
  if (listing.category === 'minecon') return listings.mineconChannelName(listing);
  return listing.ign.toLowerCase();
}

// Only the Finish control is posted, never the listing card: staff add their own
// text first and press Finish when the channel is ready.
function finishRow(listingId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rv:finish:${listingId}`).setLabel('Finish').setStyle(ButtonStyle.Success).setEmoji('🏁')
  );
}

async function rebuild(guild, { onProgress = null, includeSold = false, limit = 500 } = {}) {
  const targets = activeListings().filter((listing) => includeSold || listing.status !== 'sold').slice(0, limit);
  const channels = await guild.channels.fetch();
  const result = { created: 0, reused: 0, failed: 0, skipped: 0, total: targets.length };

  for (const [index, listing] of targets.entries()) {
    try {
      // Skip listings whose channel still exists in this guild.
      const existing = listing.listing_channel_id ? channels.get(listing.listing_channel_id) : null;
      if (existing) {
        result.skipped += 1;
        continue;
      }
      const base = await setup.ensureListingCategory(guild, listing.category, { channels, skipVisibility: true }).catch(() => null);
      const parent = base ? await tickets.categoryWithSpace(guild, base, channels).catch(() => base) : null;
      const wanted = tickets.sanitizeListingChannelName(channelNameFor(listing));

      // Reuse a same-named channel if the rebuild is run twice.
      const byName = channels.find(
        (channel) => channel && channel.type === ChannelType.GuildText && channel.name === wanted
          && (!parent || channel.parentId === parent.id)
      );
      const channel = byName || await guild.channels.create({
        name: wanted,
        type: ChannelType.GuildText,
        parent: parent ? parent.id : undefined,
        permissionOverwrites: await channelPerms.overwritesFor(guild, 'listing'),
      });
      if (byName) result.reused += 1;
      else result.created += 1;

      // The card must be re-published by staff, so clear the old message id and
      // put the listing back into the accepted (awaiting Finish) state.
      db.updateListing(listing.id, {
        listing_channel_id: channel.id,
        listing_message_id: null,
        status: listing.status === 'sold' ? 'sold' : 'accepted',
      });
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(config.EMBED_COLOR)
            .setTitle(`Recovered listing - ${listings.displayIgn(listing)}`)
            .setDescription(
              'Write the listing content here (images, description, anything you like).\n' +
              'When the channel looks right, press **Finish** and the listing embed is posted below.'
            ),
        ],
        components: [finishRow(listing.id)],
      });
    } catch (err) {
      console.error(`Rebuild failed for ${listing.ign}:`, err.message);
      result.failed += 1;
    }
    if (onProgress) await onProgress({ done: index + 1, total: targets.length });
  }
  return result;
}

// Everyone who owns an active listing, so they can be re-invited if the server
// is lost.
function proxyOwnerIds() {
  const owners = new Set();
  for (const listing of activeListings()) {
    if (listing.requester_id) owners.add(String(listing.requester_id));
  }
  return [...owners];
}

async function dmOwners(client, { message, inviteUrl = null, dryRun = false }) {
  const owners = proxyOwnerIds();
  const result = { total: owners.length, sent: 0, failed: 0, ids: owners };
  if (dryRun) return result;
  for (const id of owners) {
    const user = await client.users.fetch(id).catch(() => null);
    if (!user) {
      result.failed += 1;
      continue;
    }
    const ok = await user.send({
      content: `${message}${inviteUrl ? `\n\n${inviteUrl}` : ''}`,
    }).then(() => true).catch(() => false); // closed DMs are normal
    if (ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}

module.exports = { rebuild, dmOwners, proxyOwnerIds, activeListings, channelNameFor };
