const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, OverwriteType, ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../db');
const { requireAdmin, requireOwner, requireStaffOrHigher, isStaffOrHigher } = require('../util/perms');
const { parseDuration, formatDuration } = require('../util/time');
const tickets = require('../services/tickets');
const vouches = require('../services/vouches');
const giveaways = require('../services/giveaways');
const invites = require('../services/invites');
const pingRoles = require('../services/pingRoles');
const sync = require('../services/sync');
const logs = require('../services/logs');
const linkfilter = require('../services/linkfilter');
const channelPerms = require('../services/channelPerms');
const angels = require('../services/angels');
const embedFlow = require('../interactions/embedFlow');
const transcripts = require('../services/transcripts');
const backup = require('../services/backup');
const recovery = require('../services/recovery');
const listings = require('../services/listings');
const { buildCryptoMessage } = require('../services/crypto');
const proxyWizard = require('../interactions/proxyWizard');
const setupFlow = require('../interactions/setupFlow');
const setup = require('../services/setup');
const mojang = require('../services/mojang');
const blabit = require('../services/blabit');
const proxyCategories = require('../services/proxyCategories');
const config = require('../config');

const EPH = MessageFlags.Ephemeral;

async function handleProxy(interaction) {
  const sub = interaction.options.getSubcommand();
  // Any member may post a request for themselves; staff review it afterwards.
  // Every other subcommand manages the board and stays staff-only.
  if (sub === 'create') {
    const staff = isStaffOrHigher(interaction.member, interaction.guild);
    const specifiedOwner = staff ? interaction.options.getUser('owner') : null;
    return proxyWizard.startWizard(interaction, {
      ownerId: specifiedOwner ? specifiedOwner.id : interaction.user.id,
      // A member's own request always announces itself to staff for review.
      suppressProxyNotice: Boolean(staff && !specifiedOwner),
      hideProxyLabel: false,
    });
  }
  if (!(await requireStaffOrHigher(interaction))) return;
  if (sub === 'transfer') return transferProxy(interaction);
  if (sub === 'reassign') return reassignProxy(interaction);
  if (sub === 'check') return checkProxyIgns(interaction);
  if (sub === 'publish') return publishStuckListings(interaction);
  if (sub === 'attach') return attachProxyToTicket(interaction);
  if (sub === 'refresh') return refreshListingCards(interaction);
  if (sub === 'restore') return restoreSoldListing(interaction);
  if (sub === 'category-create') return createProxyCategory(interaction);
  if (sub === 'category-rename') return renameProxyCategory(interaction);
  if (sub === 'category-list') return listProxyCategories(interaction);
  if (sub === 'category-delete') return deleteProxyCategory(interaction);
  if (sub === 'sold-category') return setSoldCategory(interaction);
  if (sub === 'organize') return organizeProxies(interaction);

  const ign = interaction.options.getString('ign').trim();
  const listing = db.findListingByIgn(ign);
  if (!listing) {
    return interaction.reply({ content: `No request found for **${ign}**.`, flags: EPH });
  }
  if (sub === 'edit') {
    return interaction.reply({
      content: `Editing the request **${listings.displayIgn(listing)}**. What do you want to change?`,
      components: [listings.buildEditSelectRow(listing.id)],
      flags: EPH,
    });
  }
  if (sub === 'delete') {
    const localOnly = interaction.options.getBoolean('local') || false;
    return interaction.reply({
      content: `Delete the request **${listings.displayIgn(listing)}**? This removes the published message and its channel.${
        localOnly ? '\nOnly on this server: linked servers keep their copy.' : ''}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rv:delyes:${listing.id}${localOnly ? ':local' : ''}`).setLabel(localOnly ? 'Delete here only' : 'Delete').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`rv:delno:${listing.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
      flags: EPH,
    });
  }
}

async function createProxyCategory(interaction) {
  try {
    const category = proxyCategories.create(interaction.options.getString('name'));
    await setup.ensureListingCategory(interaction.guild, category.key);
    return interaction.reply({ content: `Created ${category.label} and its listing category.`, flags: EPH });
  } catch (err) {
    return interaction.reply({ content: err.message, flags: EPH });
  }
}

async function listProxyCategories(interaction) {
  const text = proxyCategories.list().map((category) => `• **${category.label}** - \`${category.key}\``).join('\n');
  return interaction.reply({ content: `**Request Categories**\n${text}`, flags: EPH });
}

async function renameProxyCategory(interaction) {
  await interaction.deferReply({ flags: EPH });
  try {
    const category = proxyCategories.rename(
      interaction.options.getString('category'),
      interaction.options.getString('name')
    );
    const discordCategoryChanged = await setup.renameListingCategory(interaction.guild, category);
    return interaction.editReply(
      `Renamed request category to **${category.label}**.${discordCategoryChanged ? ' Its Discord category was renamed too.' : ' No managed Discord category exists yet.'}`
    );
  } catch (err) {
    return interaction.editReply(err.message);
  }
}

async function deleteProxyCategory(interaction) {
  await interaction.deferReply({ flags: EPH });
  try {
    const category = proxyCategories.remove(interaction.options.getString('category'));
    const categoryResult = await setup.removeListingCategory(interaction.guild, category);
    const scope = category.builtIn ? 'built-in' : 'custom';
    const discordResult = categoryResult.removed
      ? ' Its empty Discord category was deleted too.'
      : ` ${categoryResult.reason}`;
    return interaction.editReply(`Deleted ${scope} request category **${category.label}** from the bot.${discordResult}`);
  } catch (err) {
    return interaction.editReply(err.message);
  }
}

// Reorganising a big shop touches dozens of channels, and Discord only allows
// two edits per channel per 10 minutes, so this runs in the background and
// reports progress instead of blocking the interaction.
async function organizeProxies(interaction) {
  const withPerms = interaction.options.getBoolean('permissions') || false;
  const refreshCards = interaction.options.getBoolean('refresh-cards') !== false;
  await interaction.deferReply({ flags: EPH });

  const targets = db.listingsForOrganization().filter((row) => row.status === 'published' || row.status === 'sold');
  const estimate = targets.length * (withPerms ? 2 : 1);
  await interaction.editReply(
    `Organizing ${targets.length} listing(s)...${estimate > 20 ? ' This can take several minutes because Discord rate-limits channel edits.' : ''}`
  );

  // Throttled progress so a long run never looks frozen.
  let lastProgress = Date.now();
  const tick = async (text) => {
    if (Date.now() - lastProgress < 4000) return;
    lastProgress = Date.now();
    await interaction.editReply(text).catch(() => {});
  };
  const result = await setup.organizeAllListings(interaction.guild, {
    onProgress: ({ phase, done, total }) => tick(`Step 1/2 - ${phase}: ${done}/${total}...`),
  });
  let refreshed = 0;
  let permsFixed = 0;
  let index = 0;
  for (const row of targets) {
    index += 1;
    if (refreshCards) {
      await listings.renderPublished(interaction.client, row);
      refreshed += 1;
    }
    if (withPerms) {
      const listing = db.parseListing(row);
      if (listing.listing_channel_id && await channelPerms.applyListingPerms(interaction.guild, listing.listing_channel_id)) permsFixed += 1;
      if (listing.ticket_channel_id) await channelPerms.applyTicketPerms(interaction.guild, listing.ticket_channel_id, listing.requester_id);
    }
    await tick(`Step 2/2 - refreshing listings: ${index}/${targets.length}...`);
  }
  const parts = [
    `Organized ${result.listingMoves} request channel(s) and ${result.ticketMoves} request ticket(s).`,
    result.sorted ? `Sorted ${result.sorted} listing channel(s).` : '',
    refreshCards ? `Refreshed ${refreshed} listing card(s).` : 'Skipped card refresh.',
    withPerms ? `Re-applied permissions on ${permsFixed} listing channel(s).` : 'Skipped permissions (use `permissions:true` to include them).',
    result.arranged ? `Moved ${result.arranged} overflow category/categories under their original.` : '',
  ].filter(Boolean);
  const summary = parts.join(' ');
  logs.ticket(interaction.client, 'request organize finished', `${summary} Run by <@${interaction.user.id}>.`);
  const edited = await interaction.editReply(summary).then(() => true).catch(() => false);
  if (!edited) {
    await interaction.channel.send({
      content: `<@${interaction.user.id}> request organize finished: ${summary}`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch(() => {});
  }
  return null;
}

async function setSoldCategory(interaction, categoryOverride = null) {
  const category = categoryOverride || interaction.options.getChannel('category');
  if (!category || category.guildId !== interaction.guildId || category.type !== ChannelType.GuildCategory) {
    return interaction.reply({ content: 'Choose an existing category from this server.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  db.setSetting('cat_sold', category.id);
  let moved = 0;
  for (const row of db.listingsForOrganization()) {
    const listing = db.parseListing(row);
    if (listing.status !== 'sold' || !listing.listing_channel_id) continue;
    const channel = await interaction.guild.channels.fetch(listing.listing_channel_id).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText && !tickets.inCategoryFamily(channel, category)) {
      // Sold categories fill up too, so roll over once they hit 50 channels.
      const target = await tickets.categoryWithSpace(interaction.guild, category).catch(() => category);
      await channel.setParent(target.id, { lockPermissions: false }).catch(() => {});
      moved += 1;
    }
  }
  return interaction.editReply(`Sold listings will use ${category}. Moved ${moved} existing sold listing channel(s) without changing their overwrites.`);
}

function inferredIgn(channel) {
  const ign = channel.name.replace(/[^a-z0-9_]/gi, '').slice(0, 16);
  return mojang.isValidIgn(ign) ? ign : null;
}

async function inferTicketOwner(interaction, channel, suppliedUser) {
  if (suppliedUser) return suppliedUser.id;
  const candidates = [];
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== OverwriteType.Member || !overwrite.allow.has(PermissionFlagsBits.ViewChannel)) continue;
    if (overwrite.id === interaction.client.user.id) continue;
    const member = await interaction.guild.members.fetch(overwrite.id).catch(() => null);
    if (!member || member.user.bot || isStaffOrHigher(member, interaction.guild)) continue;
    candidates.push(member.id);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function transferProxy(interaction) {
  const listingChannel = interaction.options.getChannel('proxy-channel');
  const ticketChannel = interaction.options.getChannel('ticket-channel');
  if (
    !listingChannel || !ticketChannel || listingChannel.guildId !== interaction.guildId || ticketChannel.guildId !== interaction.guildId ||
    listingChannel.type !== ChannelType.GuildText || ticketChannel.type !== ChannelType.GuildText
  ) {
    return interaction.reply({ content: 'Choose two text channels from this server.', flags: EPH });
  }
  if (listingChannel.id === ticketChannel.id) {
    return interaction.reply({ content: 'The request channel and ticket channel must be different.', flags: EPH });
  }
  if (db.getTicketByAnyChannel(ticketChannel.id)) {
    return interaction.reply({ content: 'That ticket channel is already managed. I did not create a duplicate listing.', flags: EPH });
  }
  const owner = await inferTicketOwner(interaction, ticketChannel, interaction.options.getUser('owner'));
  if (!owner) {
    return interaction.reply({ content: 'I could not reliably infer the ticket owner. Run the command again and set the optional `owner` user.', flags: EPH });
  }
  const ign = interaction.options.getString('ign')?.trim() || inferredIgn(listingChannel);
  if (!ign || !mojang.isValidIgn(ign)) {
    return interaction.reply({ content: 'Add a valid `ign` because I could not safely derive one from the request channel name.', flags: EPH });
  }
  const category = proxyCategories.resolve(interaction.options.getString('category') || 'other');
  if (!category) {
    return interaction.reply({
      content: `Unknown category. Use one of: ${proxyCategories.list().map((entry) => entry.label).join(', ')}`,
      flags: EPH,
    });
  }
  await interaction.deferReply({ flags: EPH });
  let lookupFailed = false;
  const resolved = await mojang.resolveUser(ign).catch(() => {
    lookupFailed = true; // Mojang outage: import anyway rather than blocking
    return null;
  });
  if (!resolved && !lookupFailed) {
    return interaction.editReply(`⚠️ **${ign}** is not an existing Minecraft account. Pass the real username with the \`ign\` option (use \`ign-hidden\` to keep it private).`);
  }
  const prefill = resolved && category.key === 'stats' ? await blabit.getPrefill(resolved.uuid) : null;
  const listing = db.createListing({
    ign: resolved ? resolved.name : ign,
    uuid: resolved ? resolved.uuid : null,
    category: category.key,
    capes: [],
    info: {
      ranks: prefill ? prefill.ranksNwl : '',
      stats: prefill ? prefill.stats : '',
    },
    co: 'Offer',
    bin: 'Offer',
    requesterId: owner,
    nameSuggestion: prefill ? prefill.nameSuggestion : null,
    ignHidden: interaction.options.getBoolean('ign-hidden') || false,
  });
  try {
    // Name the imported ticket up front so it matches this bot's scheme and we
    // avoid a second rename (Discord allows only two per channel per 10 min).
    const parsedListing = db.parseListing(listing);
    const ticketLabel = interaction.options.getBoolean('ign-hidden')
      ? (parsedListing.category === 'minecon' ? listings.mineconChannelName(parsedListing) : 'hidden')
      : (resolved ? resolved.name : ign);
    const takeover = await tickets.takeOverTicketChannel(interaction.guild, ticketChannel, {
      type: 'proxy', creatorId: owner, listingId: listing.id, sendWelcome: false,
      renameBase: `${ticketLabel}-request`,
    });
    // A hidden IGN must not remain visible through an imported channel name.
    // Existing message history is deliberately left untouched, but all names
    // and new bot-authored content use the private label from this point on.
    // The ticket was already named from ticketLabel above; only the public
    // listing channel still needs hiding.
    if (interaction.options.getBoolean('ign-hidden')) {
      await listingChannel.setName(tickets.sanitizeListingChannelName(ticketLabel)).catch(() => {});
    }
    // An import follows the normal review flow. The transferred ticket receives
    // one confirmation card; the public listing receives one managed card only
    // after a staff member accepts it.
    const staged = db.updateListing(listing.id, {
      ticket_channel_id: ticketChannel.id,
      listing_channel_id: listingChannel.id,
    });
    const preview = await ticketChannel.send(listings.listingPayload(db.parseListing(staged), 'preview', { revealIgn: true }));
    db.updateListing(listing.id, { preview_message_id: preview.id });
    // Imported channels keep their old access rules, so normalise both now.
    await channelPerms.applyTicketPerms(interaction.guild, ticketChannel, owner);
    await channelPerms.applyListingPerms(interaction.guild, listingChannel);
    await setup.organizeListing(interaction.guild, db.getListing(listing.id));
    return interaction.editReply({
      content: `Transferred **${interaction.options.getBoolean('ign-hidden') ? 'Hidden' : (resolved ? resolved.name : ign)}**. One review card was posted in ${ticketChannel}; staff can confirm it there. ${takeover.alreadyManaged ? 'The ticket was already managed.' : 'Existing TicketsBot messages and permissions were kept.'}`,
    });
  } catch (err) {
    db.updateListing(listing.id, { status: 'deleted' });
    throw err;
  }
}

// Puts a sold listing back on the market: republishes its card, moves the
// channel out of the sold category and pushes it back to the Angels API.
async function restoreSoldListing(interaction) {
  const ign = interaction.options.getString('ign').trim();
  const row = db.findListingByIgn(ign);
  if (!row) {
    return interaction.reply({ content: `No request found for **${ign}**.`, flags: EPH });
  }
  const listing = db.parseListing(row);
  if (listing.status !== 'sold') {
    return interaction.reply({ content: `**${listing.ign}** is not sold (status: ${listing.status}).`, flags: EPH });
  }
  const fields = { status: 'published' };
  try {
    const binInput = interaction.options.getString('bin');
    const coInput = interaction.options.getString('co');
    if (binInput) fields.bin = listings.normalizeUsdPrice(binInput);
    if (coInput) fields.co = listings.normalizeUsdPrice(coInput);
  } catch (err) {
    return interaction.reply({ content: err.message, flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });

  const updated = db.updateListing(listing.id, fields);
  const fresh = db.parseListing(updated);
  // Republish the public card, recreating it if it was removed while sold.
  let channel = fresh.listing_channel_id
    ? await interaction.client.channels.fetch(fresh.listing_channel_id).catch(() => null)
    : null;
  if (channel) {
    const card = fresh.listing_message_id
      ? await channel.messages.fetch(fresh.listing_message_id).catch(() => null)
      : null;
    if (card) {
      await listings.renderPublished(interaction.client, updated).catch(() => {});
    } else {
      const posted = await channel.send(listings.listingPayload(fresh, 'published')).catch(() => null);
      if (posted) db.updateListing(listing.id, { listing_message_id: posted.id });
    }
  }
  await listings.renderPreview(interaction.client, db.getListing(listing.id)).catch(() => {});
  await setup.organizeListing(interaction.guild, db.getListing(listing.id)).catch(() => {});
  sync.emitListingUpdate(db.getListing(listing.id)); // re-adds it to the Angels API
  logs.listing(interaction.client, 'restored from sold', fresh, interaction.user.id, [
    { name: 'BIN', value: listings.displayUsdPrice(fresh.bin), inline: true },
    { name: 'best offer', value: listings.displayUsdPrice(fresh.co), inline: true },
  ]);
  return interaction.editReply({
    content: `**${listings.displayIgn(fresh)}** is back on the market${channel ? ` in <#${channel.id}>` : ' (its channel is gone - accept it again to create one)'}. BIN **${listings.displayUsdPrice(fresh.bin)}**, best offer **${listings.displayUsdPrice(fresh.co)}**.`,
    allowedMentions: { parse: [] },
  });
}

// Re-renders listing cards so older tickets pick up the current layout (Mark
// Sold / Edit controls, the (Hidden) tag) and drops stale Mark Sold buttons
// from previous message formats.
async function refreshListingCards(interaction) {
  const ign = interaction.options.getString('ign');
  const all = interaction.options.getBoolean('all') || false;
  if (!ign && !all) {
    return interaction.reply({ content: 'Give an `ign`, or pass `all:true` to refresh every listing.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  let targets;
  if (ign) {
    const row = db.findListingByIgn(ign.trim());
    if (!row) return interaction.editReply(`No listing found for **${ign}**.`);
    targets = [row];
  } else {
    targets = db.listingsForOrganization().filter((row) => row.status !== 'deleted' && row.status !== 'denied');
  }
  let cards = 0;
  let cleared = 0;
  let index = 0;
  let lastProgress = Date.now();
  for (const row of targets) {
    index += 1;
    await listings.renderPreview(interaction.client, row).catch(() => {});
    await listings.renderPublished(interaction.client, row).catch(() => {});
    cards += 1;
    // A sold listing should not keep a usable Mark Sold button anywhere.
    if (row.status === 'sold') {
      cleared += await listings.stripSoldButtons(interaction.client, row).catch(() => 0);
    }
    if (targets.length > 5 && Date.now() - lastProgress > 5000) {
      lastProgress = Date.now();
      await interaction.editReply(`Refreshing... ${index}/${targets.length}`).catch(() => {});
    }
  }
  const summary = `Refreshed ${cards} listing card(s)${cleared ? `, cleared ${cleared} stale Mark Sold button(s)` : ''}.`;
  const edited = await interaction.editReply(summary).then(() => true).catch(() => false);
  if (!edited) {
    await interaction.channel.send({ content: `<@${interaction.user.id}> ${summary}`, allowedMentions: { users: [interaction.user.id] } }).catch(() => {});
  }
  return null;
}

// Turns an existing managed ticket (support, buy, or a proxy ticket with no
// listing yet) into a proxy listing by running the normal wizard against it.
async function attachProxyToTicket(interaction) {
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Run this in a ticket channel, or pass the ticket `channel`.', flags: EPH });
  }
  const ticket = db.getTicketByChannel(channel.id);
  if (!ticket) {
    return interaction.reply({
      content: `<#${channel.id}> is not an open ticket in this bot. Use \`/ticket takeover\` first if it came from another ticket system.`,
      flags: EPH,
    });
  }
  // A ticket may host several proxies, so an existing listing is not a blocker;
  // the new one is added alongside it.
  const listingChannel = interaction.options.getChannel('listing-channel');
  if (listingChannel && (listingChannel.guildId !== interaction.guildId || listingChannel.type !== ChannelType.GuildText)) {
    return interaction.reply({ content: 'Choose an existing text channel from this server as the listing channel.', flags: EPH });
  }
  const owner = interaction.options.getUser('owner');
  return proxyWizard.startWizard(interaction, {
    ownerId: owner ? owner.id : ticket.creator_id,
    suppressProxyNotice: true,
    boundTicketChannelId: channel.id,
    boundTicketId: ticket.id,
    boundListingChannelId: listingChannel ? listingChannel.id : null,
  });
}

// Publishes listings that are "accepted" but never got their public card, which
// happens when the Finish step is interrupted by a rate limit or a restart.
async function publishStuckListings(interaction) {
  const ign = interaction.options.getString('ign');
  await interaction.deferReply({ flags: EPH });
  const candidates = [];
  for (const row of db.listingsForOrganization()) {
    const listing = db.parseListing(row);
    const stranded = !listing.listing_channel_id && (listing.status === 'accepted' || listing.status === 'published');
    if (!stranded && (listing.status !== 'accepted' || !listing.listing_channel_id)) continue;
    if (ign && listing.ign.toLowerCase() !== ign.trim().toLowerCase()) continue;
    candidates.push(listing);
  }
  if (!candidates.length) {
    return interaction.editReply(ign ? `**${ign}** is not a stuck listing.` : 'No stuck listings found. 👍');
  }
  const done = [];
  const failed = [];
  for (const listing of candidates) {
    if (!listing.listing_channel_id) {
      db.updateListing(listing.id, { listing_message_id: null, status: 'pending' });
      failed.push(`**${listing.ign}** - no channel, reset to pending (press Accept in its ticket)`);
      continue;
    }
    const channel = await interaction.client.channels.fetch(listing.listing_channel_id).catch(() => null);
    if (!channel) {
      db.updateListing(listing.id, { listing_channel_id: null, listing_message_id: null, status: 'pending' });
      failed.push(`**${listing.ign}** - channel gone, reset to pending (accept it again)`);
      continue;
    }
    try {
      const published = await channel.send(listings.listingPayload({ ...listing, status: 'published' }, 'published'));
      const updated = db.updateListing(listing.id, { status: 'published', listing_message_id: published.id });
      await listings.renderPreview(interaction.client, updated);
      sync.emitListingUpdate(updated);
      await setup.organizeListing(interaction.guild, updated).catch(() => {});
      done.push(`**${listing.ign}** → <#${channel.id}>`);
    } catch (err) {
      failed.push(`**${listing.ign}** - ${err.message}`);
    }
  }
  return interaction.editReply({
    content: [
      done.length ? `Published ${done.length} stuck listing(s):\n${done.join('\n')}` : 'Nothing could be published.',
      failed.length ? `\nNeeds attention:\n${failed.join('\n')}` : '',
    ].join('').slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}

// Lists listings whose username looks like a placeholder ("hidden", "private")
// or no longer resolves on Mojang, so staff can correct them.
async function checkProxyIgns(interaction) {
  await interaction.deferReply({ flags: EPH });
  const flagged = [];
  const stuck = [];
  const dupeGroups = new Map();
  for (const row of db.listingsForOrganization()) {
    const listing = db.parseListing(row);
    if (listing.status === 'deleted' || listing.status === 'denied') continue;
    const reasons = [];
    if (mojang.isHiddenPlaceholder(listing.ign)) reasons.push('placeholder username');
    else if (!mojang.isValidIgn(listing.ign)) reasons.push('invalid username');
    if (!listing.uuid) reasons.push('no Mojang UUID');
    if (reasons.length) {
      flagged.push(`• **${listing.ign}** - ${reasons.join(', ')}${listing.listing_channel_id ? ` (<#${listing.listing_channel_id}>)` : ''}`);
    }
    if (listing.status === 'accepted' && listing.listing_channel_id) {
      stuck.push(`• **${listing.ign}** - accepted but never published (<#${listing.listing_channel_id}>)`);
    } else if (!listing.listing_channel_id && (listing.status === 'accepted' || listing.status === 'published')) {
      stuck.push(`• **${listing.ign}** - ${listing.status} but has no listing channel${listing.ticket_channel_id ? ` (ticket <#${listing.ticket_channel_id}>)` : ''}`);
    }
    if (listing.status === 'sold') continue;
    const key = listing.uuid ? `uuid:${listing.uuid}` : `ign:${listing.ign.toLowerCase()}`;
    if (!dupeGroups.has(key)) dupeGroups.set(key, []);
    dupeGroups.get(key).push(listing);
  }
  const dupes = [];
  for (const group of dupeGroups.values()) {
    if (group.length < 2) continue;
    const where = group.map((l) => (l.listing_channel_id ? `<#${l.listing_channel_id}>` : `ticket <#${l.ticket_channel_id}>`)).join(', ');
    dupes.push(`• **${group[0].ign}** - listed ${group.length}× (${where})`);
  }
  const sections = [];
  if (dupes.length) sections.push(`**⚠️ Double-proxied accounts (${dupes.length})**\n${dupes.join('\n')}`);
  if (stuck.length) sections.push(`**Stuck half-accepted (${stuck.length})** - fix with \`/request publish\`\n${stuck.join('\n')}`);
  if (flagged.length) sections.push(`**Bad usernames (${flagged.length})** - fix with \`/request edit\`, use \`/request hide\` for privacy\n${flagged.join('\n')}`);
  if (!sections.length) {
    return interaction.editReply('No duplicates, stuck listings or bad usernames. 👍');
  }
  return interaction.editReply({
    content: sections.join('\n\n').slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}

// Hides or reveals the username on an existing listing. Channel names are
// renamed too, otherwise a hidden IGN still leaks through the sidebar.
async function reassignProxy(interaction) {
  const ign = interaction.options.getString('ign').trim();
  const newOwner = interaction.options.getUser('user');
  const row = db.findListingByIgn(ign);
  if (!row) {
    return interaction.reply({ content: `No request found for **${ign}**.`, flags: EPH });
  }
  const listing = db.parseListing(row);
  if (listing.status === 'deleted' || listing.status === 'denied') {
    return interaction.reply({ content: 'That listing is not active.', flags: EPH });
  }
  if (newOwner.bot) {
    return interaction.reply({ content: 'You cannot transfer a request to a bot.', flags: EPH });
  }
  if (String(listing.requester_id) === newOwner.id) {
    return interaction.reply({ content: `<@${newOwner.id}> already owns that request.`, flags: EPH, allowedMentions: { parse: [] } });
  }
  const member = await interaction.guild.members.fetch(newOwner.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: 'That user is not in this server.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });

  const previousOwnerId = listing.requester_id;
  // 1. Ask the previous proxy ticket to close, if one is still open.
  let closedNote = 'No previous ticket was open.';
  if (listing.ticket_channel_id) {
    const oldTicket = db.getTicketByChannel(listing.ticket_channel_id);
    const oldChannel = oldTicket
      ? await interaction.client.channels.fetch(listing.ticket_channel_id).catch(() => null)
      : null;
    if (oldTicket && oldChannel) {
      const result = await tickets.startClosePrompt(oldChannel, oldTicket, interaction.user.id, null);
      closedNote = result.alreadyPending
        ? `The old ticket <#${oldChannel.id}> already had a close request pending.`
        : `Close request sent to the old ticket <#${oldChannel.id}> (auto-closes in ${result.timeoutText}).`;
    }
  }

  // 2. Open a fresh proxy ticket owned by the new user.
  const displayName = listing.ign_hidden && listing.category === 'minecon'
    ? listings.mineconChannelName(listing)
    : listings.displayIgn(listing);
  const { channel, ticket } = await tickets.createTicketChannel(interaction.guild, {
    baseName: `${displayName}-request`,
    categoryKey: 'proxy',
    type: 'proxy',
    creatorId: newOwner.id,
    listingId: listing.id,
  });
  await tickets.sendTicketWelcome(
    channel,
    ticket,
    `This request for **${listings.displayIgn(listing)}** was transferred to you by <@${interaction.user.id}>. Staff will coordinate the handover here.`
  );

  // 3. Repoint the listing at the new owner and ticket, and post a fresh card.
  db.setListingRequester(listing.id, newOwner.id);
  const staged = db.updateListing(listing.id, { ticket_channel_id: channel.id });
  const preview = await channel.send(
    listings.listingPayload(db.parseListing(staged), listing.status === 'pending' ? 'preview' : 'plain', { revealIgn: true })
  );
  db.updateListing(listing.id, { preview_message_id: preview.id });
  // No separate Sold message: the listing card posted above already carries the
  // Mark Sold control once the listing is accepted.
  // Ownership changed, so re-apply the standard access rules to both channels.
  await channelPerms.applyTicketPerms(interaction.guild, channel, newOwner.id);
  if (listing.listing_channel_id) await channelPerms.applyListingPerms(interaction.guild, listing.listing_channel_id);
  await setup.organizeListing(interaction.guild, db.getListing(listing.id));
  logs.listing(interaction.client, 'transferred', listing, interaction.user.id, [
    { name: 'From', value: `<@${previousOwnerId}>`, inline: true },
    { name: 'To', value: `<@${newOwner.id}>`, inline: true },
    { name: 'New ticket', value: `<#${channel.id}>`, inline: true },
  ]);

  return interaction.editReply({
    content: `Transferred **${listings.displayIgn(listing)}** from <@${previousOwnerId}> to <@${newOwner.id}>.\nNew ticket: <#${channel.id}>. ${closedNote}`,
    allowedMentions: { parse: [] },
  });
}

async function handlePanel(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const type = interaction.options.getString('type');
  const payload = type === 'proxy' ? setup.buildProxyPanel() : setup.buildTicketPanel();
  await interaction.channel.send(payload);
  return interaction.reply({ content: 'Panel posted.', flags: EPH });
}

async function handleClose(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const ticket = db.getTicketByChannel(interaction.channelId);
  if (!ticket) {
    return interaction.reply({ content: 'This is not an open ticket channel.', flags: EPH });
  }
  const keepListing = interaction.options.getBoolean('keep-proxy') || false;
  if (interaction.options.getBoolean('now')) {
    await interaction.reply({ content: 'Closing this ticket now.', flags: EPH });
    return tickets.performClose(interaction.client, ticket, `closed by ${interaction.user.tag}`, { keepListing });
  }
  const timeInput = interaction.options.getString('time');
  let ms = null;
  if (timeInput) {
    ms = parseDuration(timeInput);
    if (!ms) {
      return interaction.reply({ content: 'Invalid time. Try something like 45m, 2h or 1d.', flags: EPH });
    }
  }
  const forced = interaction.options.getBoolean('force') || false;
  await interaction.deferReply({ flags: EPH });
  const result = await tickets.startClosePrompt(interaction.channel, ticket, interaction.user.id, ms, { forced, keepListing });
  if (result.alreadyPending) {
    return interaction.editReply({
      content: `A close request is already pending, this ticket closes <t:${Math.floor(result.closeAt / 1000)}:R>${result.forced ? ' and cannot be cancelled.' : ' unless the creator keeps it open.'}`,
    });
  }
  return interaction.editReply({
    content: forced
      ? `Forced close set. This ticket closes in ${result.timeoutText} and the creator cannot cancel it.`
      : `Close request sent. The ticket closes automatically in ${result.timeoutText} if the creator does not respond.`,
  });
}

// Reads when a channel was last spoken in, so tickets that are already stale
// are counted from their real last message rather than from "now".
async function lastActivityOf(channel) {
  const messages = await channel.messages.fetch({ limit: 5 }).catch(() => null);
  if (!messages || !messages.size) return channel.createdTimestamp || Date.now();
  const human = messages.find((message) => !message.author.bot);
  const newest = human || messages.first();
  return newest.createdTimestamp;
}

async function handleInactive(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const watches = db.allInactivityWatches();
    if (!watches.length) return interaction.reply({ content: 'No tickets are being watched for inactivity.', flags: EPH });
    const lines = watches.slice(0, 20).map((w) => {
      const at = Math.floor((w.last_activity + w.timeout_ms) / 1000);
      return `• <#${w.channel_id}> - closes <t:${at}:R>${w.silent ? ' (silent)' : ''}`;
    });
    return interaction.reply({
      content: `Watching ${watches.length} ticket(s):\n${lines.join('\n')}`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'cancel') {
    if (interaction.options.getBoolean('all')) {
      const watches = db.allInactivityWatches();
      for (const watch of watches) db.removeInactivityWatch(watch.channel_id);
      return interaction.reply({ content: `Cancelled ${watches.length} inactivity watch(es).`, flags: EPH });
    }
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const removed = db.removeInactivityWatch(channel.id);
    return interaction.reply({
      content: removed ? `<#${channel.id}> is no longer watched.` : `<#${channel.id}> was not being watched.`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  }

  const timeoutMs = parseDuration(interaction.options.getString('time'));
  if (!timeoutMs) {
    return interaction.reply({ content: 'Invalid time. Try 3d, 1w or 14d (min 1m, max 14d).', flags: EPH });
  }
  const silent = interaction.options.getBoolean('silent') !== false;

  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const ticket = db.getTicketByChannel(channel.id);
    if (!ticket) {
      return interaction.reply({ content: `<#${channel.id}> is not an open ticket.`, flags: EPH, allowedMentions: { parse: [] } });
    }
    const action = interaction.options.getString('action') || 'request';
    const closeInput = interaction.options.getString('close-time');
    let closeMs = null;
    if (closeInput) {
      closeMs = parseDuration(closeInput);
      if (!closeMs) return interaction.reply({ content: 'Invalid close-time. Try 12h, 24h or 2d.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const lastActivity = await lastActivityOf(channel);
    db.setInactivityWatch({
      channelId: channel.id, ticketId: ticket.id, timeoutMs, lastActivity, silent,
      armedBy: interaction.user.id, action, closeMs,
    });
    const firesAt = Math.floor((lastActivity + timeoutMs) / 1000);
    const whatHappens = action === 'now'
      ? `it closes ${silent ? 'silently' : 'with a notice'}`
      : action === 'force'
      ? `a forced close starts (${closeMs ? formatDuration(closeMs) : '24h'}, not cancellable)`
      : `the normal close request is sent (${closeMs ? formatDuration(closeMs) : '24h'} to respond)`;
    logs.ticket(interaction.client, 'inactivity watch set', `<#${channel.id}> - after ${formatDuration(timeoutMs)} of silence, ${whatHappens}. Set by <@${interaction.user.id}>.`);
    return interaction.editReply({
      content: `Watching <#${channel.id}> quietly. If nobody writes before <t:${firesAt}:R>, ${whatHappens}. Any message resets the timer.`,
      allowedMentions: { parse: [] },
    });
  }

  return null;
}

async function handleAdd(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const ticket = db.getTicketByChannel(interaction.channelId);
  if (!ticket) {
    return interaction.reply({ content: 'This is not an open ticket channel.', flags: EPH });
  }
  const user = interaction.options.getUser('user');
  await interaction.channel.permissionOverwrites.edit(
    user.id,
    { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true },
    { type: OverwriteType.Member }
  );
  return interaction.reply({
    content: `Added <@${user.id}> to this ticket.`,
    allowedMentions: { users: [user.id] },
  });
}

async function handleCrypto(interaction) {
  const amount = interaction.options.getNumber('amount');
  const currency = interaction.options.getString('currency');
  const hidden = interaction.options.getBoolean('hidden') !== false;
  if (hidden) await interaction.deferReply({ flags: EPH });
  else await interaction.deferReply();
  return interaction.editReply(await buildCryptoMessage({ amount, currency }));
}

async function handleSetWallet(interaction) {
  const coinKey = interaction.options.getString('coin');
  const address = interaction.options.getString('address').trim();
  const def = config.WALLET_COINS.find((coin) => coin.key === coinKey);
  if (!def) {
    return interaction.reply({ content: 'Unknown coin.', flags: EPH });
  }
  if (!address || /\s/.test(address)) {
    return interaction.reply({ content: 'Enter a valid address with no spaces.', flags: EPH });
  }
  db.setWallet(interaction.user.id, def.key, address);
  return interaction.reply({
    content: `Saved your **${def.label}** address:\n\`${address}\`\nOthers can see it with \`/wallet user:@you\`.`,
    flags: EPH,
    allowedMentions: { parse: [] },
  });
}

async function handleWallet(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const coinKey = interaction.options.getString('coin');
  const hidden = interaction.options.getBoolean('hidden') === true;
  const rows = coinKey
    ? [db.getWallet(target.id, coinKey)].filter(Boolean)
    : db.getWallets(target.id);
  if (!rows.length) {
    const isSelf = target.id === interaction.user.id;
    return interaction.reply({
      content: isSelf
        ? 'You have no saved addresses yet. Add one with `/setwallet`.'
        : `<@${target.id}> has no saved ${coinKey ? 'address for that coin' : 'wallet addresses'}.`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  }
  const labelFor = (key) => (config.WALLET_COINS.find((coin) => coin.key === key) || {}).label || key.toUpperCase();
  const embed = new EmbedBuilder()
    .setColor(config.EMBED_COLOR)
    .setTitle(`${target.username}'s wallet`)
    .setDescription(rows.map((row) => `**${labelFor(row.coin)}**\n\`${row.address}\``).join('\n\n'));
  return interaction.reply({
    embeds: [embed],
    flags: hidden ? EPH : undefined,
    allowedMentions: { parse: [] },
  });
}

async function handleGiveaway(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    const prize = interaction.options.getString('prize').trim();
    const durationInput = interaction.options.getString('duration');
    let durationMs = null;
    if (durationInput) {
      durationMs = parseDuration(durationInput);
      if (!durationMs) {
        return interaction.reply({ content: 'Invalid duration. Try 30m, 2h or 1d (min 1m, max 14d), or leave it blank for no timer.', flags: EPH });
      }
    }
    const winners = interaction.options.getInteger('winners') || 1;
    const requiredRole = interaction.options.getRole('required-role');
    const minInvites = interaction.options.getInteger('min-invites') || 0;
    const goalInvites = interaction.options.getInteger('goal-invites') || null;
    if ((minInvites || goalInvites) && !invites.isTracking()) {
      return interaction.reply({ content: 'Invite tracking is off, so invite requirements will not work. Give me the **Manage Server** permission, then restart me and try again.', flags: EPH });
    }
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    if (!targetChannel || targetChannel.guildId !== interaction.guildId || !targetChannel.isTextBased()) {
      return interaction.reply({ content: 'Choose a text channel from this server to post the giveaway in.', flags: EPH });
    }
    const permissions = targetChannel.permissionsFor(interaction.guild.members.me);
    if (!permissions || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.ViewChannel)) {
      return interaction.reply({ content: `I cannot post in ${targetChannel}. Give me View Channel + Send Messages there first.`, flags: EPH });
    }
    const host = interaction.options.getUser('host') || interaction.user;
    await interaction.deferReply({ flags: EPH });
    const giveaway = await giveaways.start(interaction, {
      prize, winners, durationMs, channel: targetChannel, hostId: host.id,
      requiredRoleId: requiredRole ? requiredRole.id : null,
      minInvites,
      goalInvites,
    });
    const extras = [];
    if (!durationMs) extras.push('no timer');
    if (requiredRole) extras.push(`role ${requiredRole}`);
    if (minInvites) extras.push(`min ${minInvites} invites`);
    if (goalInvites) extras.push(`invite race to ${goalInvites}`);
    return interaction.editReply({
      content: `Giveaway started for **${prize}** in ${targetChannel} (${winners} winner${winners > 1 ? 's' : ''}${extras.length ? `, ${extras.join(', ')}` : ''}). Message ID: \`${giveaway.message_id}\`.`,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'list') {
    const rows = db.activeGiveaways();
    if (!rows.length) {
      return interaction.reply({ content: 'No active giveaways.', flags: EPH });
    }
    const lines = rows.map((g) => {
      const ends = g.end_at ? `ends <t:${Math.floor(g.end_at / 1000)}:R>` : 'no timer';
      return `• **${g.prize}** - ${db.giveawayEntryCount(g.id)} entries, ${ends} (<#${g.channel_id}>, ID \`${g.message_id || '-'}\`)`;
    });
    return interaction.reply({ content: lines.join('\n').slice(0, 1900), flags: EPH, allowedMentions: { parse: [] } });
  }

  // end / reroll / cancel all resolve a giveaway by its message ID.
  const messageId = interaction.options.getString('message').trim();
  const giveaway = db.getGiveawayByMessage(messageId);
  if (!giveaway) {
    return interaction.reply({ content: 'No giveaway found for that message ID. Use `/giveaway list` to see IDs.', flags: EPH });
  }

  if (sub === 'end') {
    if (giveaway.status !== 'active') {
      return interaction.reply({ content: 'That giveaway is not active.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const ended = await giveaways.endNow(interaction.client, giveaway);
    const winnerIds = ended ? JSON.parse(ended.winner_ids || '[]') : [];
    return interaction.editReply({
      content: winnerIds.length ? `Giveaway ended. Winner(s): ${winnerIds.map((id) => `<@${id}>`).join(', ')}.` : 'Giveaway ended with no valid entries.',
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'reroll') {
    await interaction.deferReply({ flags: EPH });
    const result = await giveaways.reroll(interaction.client, giveaway, interaction.options.getInteger('winners'));
    return interaction.editReply({
      content: result.ok ? `Rerolled. New winner(s): ${result.winnerIds.map((id) => `<@${id}>`).join(', ')}.` : result.reason,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'cancel') {
    await interaction.deferReply({ flags: EPH });
    const result = await giveaways.cancel(interaction.client, giveaway);
    return interaction.editReply({ content: result.ok ? 'Giveaway cancelled; no winner was drawn.' : result.reason });
  }
}

async function handleInvites(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  const note = invites.isTracking() ? '' : '\n⚠️ Invite tracking is off (I need the Manage Server permission).';
  const when = (ts) => `<t:${Math.floor(ts / 1000)}:d>`;

  if (sub === 'leaderboard') {
    const rows = db.inviteLeaderboard(15);
    if (!rows.length) return interaction.reply({ content: `No invites tracked yet.${note}`, flags: EPH });
    const lines = rows.map((row, i) => `**${i + 1}.** <@${row.inviter_id}> - **${row.count}**`);
    const embed = new EmbedBuilder().setColor(config.EMBED_COLOR).setTitle('Top inviters').setDescription(lines.join('\n'));
    return interaction.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
  }

  if (sub === 'list') {
    const target = interaction.options.getUser('user') || interaction.user;
    const includeLeft = interaction.options.getBoolean('include-left') !== false;
    const rows = db.invitedMembersOf(target.id, { includeLeft });
    if (!rows.length) {
      return interaction.reply({ content: `<@${target.id}> has not invited anyone yet.${note}`, flags: EPH, allowedMentions: { parse: [] } });
    }
    const lines = rows.slice(0, 25).map((row) => `• <@${row.member_id}> - joined ${when(row.joined_at)}${row.active ? '' : ' _(left)_'}`);
    const stayed = rows.filter((row) => row.active).length;
    const embed = new EmbedBuilder()
      .setColor(config.EMBED_COLOR)
      .setTitle(`Invited by ${target.username}`)
      .setDescription(`${lines.join('\n')}${rows.length > 25 ? `\n...and ${rows.length - 25} more` : ''}`)
      .setFooter({ text: `${rows.length} total · ${stayed} still in the server` });
    return interaction.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
  }

  if (sub === 'who') {
    const target = interaction.options.getUser('user');
    const record = db.getInvitedMember(target.id);
    if (!record) {
      return interaction.reply({ content: `No invite record for <@${target.id}> (they may predate tracking, or joined via vanity URL).${note}`, flags: EPH, allowedMentions: { parse: [] } });
    }
    return interaction.reply({
      content: `<@${target.id}> was invited by <@${record.inviter_id}>, joined ${when(record.joined_at)}${record.active ? '' : ' (has since left)'}.`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'all') {
    const rows = db.invitePairs({ limit: 200 });
    if (!rows.length) return interaction.reply({ content: `Nothing tracked yet.${note}`, flags: EPH });
    const lines = rows.slice(0, 30).map((row) => `<@${row.member_id}> ← <@${row.inviter_id}> ${when(row.joined_at)}${row.active ? '' : ' _(left)_'}`);
    const embed = new EmbedBuilder()
      .setColor(config.EMBED_COLOR)
      .setTitle('Who invited whom')
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Showing ${Math.min(30, rows.length)} of ${rows.length} tracked joins` });
    return interaction.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
  }

  const target = interaction.options.getUser('user') || interaction.user;
  const count = db.getInviteCount(target.id);
  return interaction.reply({
    content: `<@${target.id}> has **${count}** invite${count === 1 ? '' : 's'}.${note}`,
    flags: EPH,
    allowedMentions: { parse: [] },
  });
}

async function handleBackup(interaction) {
  if (!(await requireOwner(interaction))) return;
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const snapshots = backup.listSnapshots();
    if (!snapshots.length) {
      return interaction.reply({ content: 'No snapshots yet. Run `/backup now`, or wait for the nightly one.', flags: EPH });
    }
    const lines = snapshots.map((snapshot) => {
      let meta = {};
      try {
        meta = JSON.parse(require('node:fs').readFileSync(require('node:path').join(snapshot.dir, 'meta.json'), 'utf8'));
      } catch (err) {
        meta = {};
      }
      return `• \`${snapshot.name}\` - ${meta.listings ?? '?'} listings, ${meta.ticketTranscripts ?? '?'} ticket transcripts`;
    });
    return interaction.reply({
      content: `Kept on the host (newest last, ${backup.KEEP} retained):\n${lines.join('\n')}\n\nLocation: \`${backup.ROOT}\``,
      flags: EPH,
    });
  }
  await interaction.deferReply({ flags: EPH });
  const result = await backup.run(interaction.client);
  logs.send(interaction.client, { title: 'Backup created', description: `${result.listings} listings, ${result.ticketTranscripts} ticket transcripts - by <@${interaction.user.id}>` });
  return interaction.editReply(
    `Backup saved: **${result.listings}** listings, **${result.openTickets}** open tickets, **${result.ticketTranscripts}** ticket transcripts${result.databaseCopied ? ', database copied' : ''}. Kept the newest ${backup.KEEP}${result.pruned ? `, pruned ${result.pruned}` : ''}.`
  );
}

async function handleRecover(interaction) {
  if (!(await requireOwner(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'preview') {
    const items = recovery.activeListings();
    const owners = recovery.proxyOwnerIds();
    const missing = items.filter((listing) => !listing.listing_channel_id
      || !interaction.guild.channels.cache.get(listing.listing_channel_id));
    return interaction.reply({
      content: [
        `**${items.length}** active listing(s) in the database, owned by **${owners.length}** member(s).`,
        `**${missing.length}** would get a new channel here; the rest already exist in this server.`,
        '',
        'Rebuild posts only a **Finish** button in each new channel, so you can write the content first.',
      ].join('\n'),
      flags: EPH,
    });
  }

  if (sub === 'rebuild') {
    await interaction.deferReply({ flags: EPH });
    let last = Date.now();
    const result = await recovery.rebuild(interaction.guild, {
      includeSold: interaction.options.getBoolean('include-sold') || false,
      onProgress: async ({ done, total }) => {
        if (Date.now() - last < 4000) return;
        last = Date.now();
        await interaction.editReply(`Rebuilding... ${done}/${total}`).catch(() => {});
      },
    });
    logs.send(interaction.client, { title: 'Recovery rebuild', description: `${result.created} channel(s) created by <@${interaction.user.id}>` });
    const summary = `Rebuilt **${result.created}** listing channel(s)${result.reused ? `, reused ${result.reused}` : ''}${result.skipped ? `, skipped ${result.skipped} that still exist` : ''}${result.failed ? `, ${result.failed} failed` : ''}. Each has a **Finish** button - write your content, then press it to post the listing.`;
    const edited = await interaction.editReply(summary).then(() => true).catch(() => false);
    if (!edited) await interaction.channel.send({ content: `<@${interaction.user.id}> ${summary}`, allowedMentions: { users: [interaction.user.id] } }).catch(() => {});
    return null;
  }

  if (sub === 'dm-owners') {
    const message = interaction.options.getString('message');
    const invite = interaction.options.getString('invite');
    const dryRun = interaction.options.getBoolean('dry-run') || false;
    await interaction.deferReply({ flags: EPH });
    const result = await recovery.dmOwners(interaction.client, { message, inviteUrl: invite, dryRun });
    if (dryRun) {
      return interaction.editReply(`Dry run: **${result.total}** request owner(s) would be messaged.`);
    }
    logs.send(interaction.client, { title: 'Owners messaged', description: `${result.sent}/${result.total} request owners DMed by <@${interaction.user.id}>` });
    return interaction.editReply(`DMed **${result.sent}/${result.total}** request owner(s)${result.failed ? ` - ${result.failed} could not be reached (DMs closed or left Discord)` : ''}.`);
  }
  return null;
}

async function handleTranscript(interaction) {
  if (!(await requireStaffOrHigher(interaction))) return;
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased()) {
    return interaction.reply({ content: 'Run this in a ticket, or pass a `channel`.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  const ticket = db.getTicketByAnyChannel(channel.id) || null;
  const dmTarget = interaction.options.getUser('dm');
  const pseudoTicket = ticket || { number: 0, type: 'channel', creator_id: null };
  // Always archive and always DM the ticket owner; `dm:` just adds someone.
  const result = await transcripts.archive(interaction.client, channel, pseudoTicket, {
    dmUser: true,
    extraDmIds: dmTarget ? [dmTarget.id] : [],
  });
  if (!result.messages) {
    return interaction.editReply('That channel has no messages to save.');
  }
  const dmNote = result.attempted
    ? ` DMed to ${result.dmCount}/${result.attempted} recipient(s)${result.dmCount < result.attempted ? ' (the rest have DMs closed)' : ''}.`
    : '';
  return interaction.editReply(
    `Saved a transcript of <#${channel.id}> (${result.messages} messages)${result.saved ? ' to the transcripts channel' : ''}.${dmNote}`
  );
}

async function handlePingRoles(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  const me = interaction.guild.members.me;

  if (sub === 'list') {
    const rows = db.listPingRoles();
    if (!rows.length) {
      return interaction.reply({ content: 'No ping roles yet. Run `/pingroles post` to create them.', flags: EPH });
    }
    const text = rows.map((r) => `• ${r.emoji ? `${r.emoji} ` : ''}**${r.label}** - <@&${r.role_id}>`).join('\n');
    return interaction.reply({ content: text.slice(0, 1900), flags: EPH, allowedMentions: { parse: [] } });
  }

  if (sub === 'preview') {
    return interaction.reply({ ...pingRoles.previewPanel(interaction.guild), flags: EPH });
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({ content: 'I need the **Manage Roles** permission to create and assign ping roles.', flags: EPH });
  }

  if (sub === 'post') {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased()) {
      return interaction.reply({ content: 'Choose a text channel from this server.', flags: EPH });
    }
    const perms = channel.permissionsFor(me);
    if (!perms || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ViewChannel)) {
      return interaction.reply({ content: `I cannot post in ${channel}. Give me View Channel + Send Messages there.`, flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const message = await pingRoles.post(interaction.guild, channel);
    const count = db.countPingRoles();
    return interaction.editReply({
      content: `Posted the ping-role panel in ${channel} with **${count}** role${count === 1 ? '' : 's'} (Giveaways + every category). Add more with \`/pingroles add\`.`,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'add') {
    const label = interaction.options.getString('label');
    const emoji = interaction.options.getString('emoji');
    const role = interaction.options.getRole('role');
    if (role && role.comparePositionTo(me.roles.highest) >= 0) {
      return interaction.reply({ content: 'That role is above my highest role, so I could not assign it. Move my role above it first.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    try {
      const created = await pingRoles.addCustom(interaction.guild, { label, emoji, existingRole: role });
      const refreshed = await pingRoles.refreshPanel(interaction.client);
      return interaction.editReply({
        content: `Added ping role **${created.label}**.${refreshed ? '' : ' Run `/pingroles post` to publish the panel.'}`,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      return interaction.editReply(err.message);
    }
  }

  if (sub === 'remove') {
    const role = interaction.options.getRole('role');
    const row = db.getPingRoleByRoleId(role.id);
    if (!row) {
      return interaction.reply({ content: 'That role is not on the ping-role panel.', flags: EPH });
    }
    db.removePingRole(row.id);
    await pingRoles.refreshPanel(interaction.client);
    return interaction.reply({ content: `Removed **${row.label}** from the panel. The Discord role itself was kept.`, flags: EPH, allowedMentions: { parse: [] } });
  }
}

async function handleRole(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const user = interaction.options.getUser('user');
  const role = interaction.options.getRole('role');
  const remove = interaction.options.getBoolean('remove') || false;

  if (role.managed) {
    return interaction.reply({ content: 'That role is managed by an integration and cannot be assigned.', flags: EPH });
  }
  const me = interaction.guild.members.me;
  if (role.comparePositionTo(me.roles.highest) >= 0) {
    return interaction.reply({ content: 'That role is above my highest role, I cannot manage it.', flags: EPH });
  }
  if (
    interaction.guild.ownerId !== interaction.user.id &&
    role.comparePositionTo(interaction.member.roles.highest) >= 0
  ) {
    return interaction.reply({ content: 'You can only manage roles below your own highest role.', flags: EPH });
  }
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: 'That user is not in this server.', flags: EPH });
  }
  if (remove) await member.roles.remove(role);
  else await member.roles.add(role);
  return interaction.reply({
    content: `${remove ? 'Removed' : 'Gave'} ${role} ${remove ? 'from' : 'to'} <@${user.id}>.`,
    flags: EPH,
    allowedMentions: { parse: [] },
  });
}

async function handleVouch(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  // Resolving the vouch channel, role and member are all REST calls, so
  // acknowledge the command before any of them run.
  if (sub !== 'add') await interaction.deferReply({ flags: EPH });
  const reply = (content) => (sub === 'add'
    ? interaction.reply({ content, flags: EPH })
    : interaction.editReply({ content, allowedMentions: { parse: [] } }));
  const channelId = db.getSetting('vouch_channel');
  const channel = channelId
    ? await interaction.client.channels.fetch(channelId).catch(() => null)
    : null;
  if (!channel) {
    return reply('No vouches channel found. Run /setup first.');
  }
  if (sub === 'add') {
    return handleVouchAdd(interaction, channel);
  }
  const user = interaction.options.getUser('user');
  const customerRoleId = db.getSetting('customer_role');
  const customerRole = customerRoleId
    ? await interaction.guild.roles.fetch(customerRoleId).catch(() => null)
    : null;
  if (!customerRole) {
    return reply('No Client role is configured. Run /setup first.');
  }
  if (!customerRole.editable) {
    return reply('Move my role above the Client role, then try again.');
  }
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return reply('That user is not in this server.');
  }
  if (!member.roles.cache.has(customerRole.id)) await member.roles.add(customerRole, 'Prompted to leave a vouch');
  // Self-heal the vouch channel so the Client role can actually post a vouch,
  // even if the configured channel predates this permission being granted.
  await setup.ensureVouchPermissions(channel).catch(() => {});
  await vouches.vouchPing(channel, user);
  return reply(`Gave <@${user.id}> the Client role and pinged them in <#${channel.id}>.`);
}

async function handleVouchAdd(interaction, channel) {
  const link = interaction.options.getString('message').trim();
  const match = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) {
    return interaction.reply({ content: 'That is not a valid Discord message link. Right-click the vouch message and choose Copy Message Link.', flags: EPH });
  }
  const [, linkGuildId, srcChannelId, messageId] = match;
  if (linkGuildId !== interaction.guildId) {
    return interaction.reply({ content: 'That message link is from a different server.', flags: EPH });
  }
  const voucher = interaction.options.getUser('voucher');
  const recipient = interaction.options.getUser('vouched-for');
  if (voucher.bot || recipient.bot) {
    return interaction.reply({ content: 'Vouches must be between real users, not bots.', flags: EPH });
  }
  if (voucher.id === recipient.id) {
    return interaction.reply({ content: 'The voucher and the vouched-for user cannot be the same person.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  // Best-effort read of the original message so the vouch keeps its real date.
  let createdAt = Date.now();
  const srcChannel = await interaction.client.channels.fetch(srcChannelId).catch(() => null);
  const srcMessage = srcChannel && typeof srcChannel.messages?.fetch === 'function'
    ? await srcChannel.messages.fetch(messageId).catch(() => null)
    : null;
  if (srcMessage) createdAt = srcMessage.createdTimestamp;
  const result = await vouches.addManualVouch(channel, {
    messageId, voucherId: voucher.id, recipientId: recipient.id, createdAt,
  });
  return interaction.editReply({
    content: result.added
      ? `Recorded a vouch for <@${recipient.id}> (vouched by <@${voucher.id}>). Total vouches: **${db.getVouchCount()}**.`
      : `That message was already counted as a vouch. Made sure <@${recipient.id}> is credited. Total vouches: **${db.getVouchCount()}**.`,
    allowedMentions: { parse: [] },
  });
}

async function handleLink(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  const me = config.GUILD_ID;

  if (sub === 'list') {
    const linked = sync.linkedGuilds(me);
    if (!linked.length) {
      return interaction.reply({ content: 'No linked servers.', flags: EPH });
    }
    const direct = new Set(sync.directLinks(me));
    const lines = linked.map((g) => `• \`${g}\`${direct.has(g) ? '' : ' _(via the link network)_'}`);
    return interaction.reply({
      content: `This server syncs with **${linked.length}** other server(s):\n${lines.join('\n')}`,
      flags: EPH,
    });
  }
  if (sub === 'sync') {
    const count = sync.pushAllLocal();
    return interaction.reply({ content: `Pushed ${count} listing(s) to linked servers.`, flags: EPH });
  }

  const guildId = interaction.options.getString('guild').trim();
  if (!/^\d{5,20}$/.test(guildId)) {
    return interaction.reply({ content: 'Give a valid server (guild) ID - numbers only. Enable Developer Mode, right-click the server, Copy Server ID.', flags: EPH });
  }
  if (guildId === me) {
    return interaction.reply({ content: 'That is this server.', flags: EPH });
  }
  if (sub === 'add') {
    sync.link(me, guildId);
    const count = sync.pushAllLocal();
    return interaction.reply({
      content: `Linked with \`${guildId}\` and pushed ${count} listing(s). Run \`/link add\` on that server too (pointing back here) so it pushes its listings to us.`,
      flags: EPH,
    });
  }
  if (sub === 'remove') {
    sync.unlink(me, guildId);
    return interaction.reply({ content: `Unlinked \`${guildId}\`.`, flags: EPH });
  }
}

async function handleBin(interaction) {
  if (!(await requireStaffOrHigher(interaction))) return;
  const ign = interaction.options.getString('ign').trim();
  const row = db.findListingByIgn(ign);
  if (!row) {
    return interaction.reply({ content: `No request found for **${ign}**.`, flags: EPH });
  }
  const listing = db.parseListing(row);
  let amount;
  try {
    amount = listings.normalizeUsdPrice(interaction.options.getString('amount'));
  } catch (err) {
    return interaction.reply({ content: err.message, flags: EPH });
  }
  if (amount === listing.bin) {
    return interaction.reply({ content: `**${listings.displayIgn(listing)}** already pays **${listings.displayUsdPrice(amount)}**.`, flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  const verb = listings.priceChangeVerb(listing.bin, amount);
  const updated = db.updateListing(listing.id, { bin: amount });
  await listings.renderPublished(interaction.client, updated).catch(() => {});
  await listings.renderPreview(interaction.client, updated).catch(() => {});
  sync.emitListingUpdate(updated);
  if (interaction.options.getBoolean('announce') !== false) {
    await listings.announceListingUpdate(interaction.client, updated, `Now paying **${listings.displayUsdPrice(amount)}**`);
  }
  logs.listing(interaction.client, `Budget ${verb}`, listing, interaction.user.id, [
    { name: 'Old', value: listings.displayUsdPrice(listing.bin), inline: true },
    { name: 'New', value: listings.displayUsdPrice(amount), inline: true },
  ]);
  return interaction.editReply(`Budget of **${listings.displayIgn(listing)}** ${verb} to **${listings.displayUsdPrice(amount)}**.`);
}

// Backfills the Offer again control into open tickets that carry an offer but
// predate the button. Skips any ticket that already shows one, so it is safe to
// run repeatedly.
async function refreshOfferTickets(interaction) {
  await interaction.deferReply({ flags: EPH });
  let added = 0;
  let skipped = 0;
  const problems = [];
  for (const ticket of db.openTickets()) {
    const offers = db.ticketItems(ticket.id).filter((item) => item.kind === 'offer' && item.listing_id);
    if (!offers.length) continue;
    // Newest offer wins: that is the listing the buyer would bid on again.
    const listingRow = db.getListing(offers[offers.length - 1].listing_id);
    const listing = listingRow ? db.parseListing(listingRow) : null;
    if (!listing || listing.status !== 'published') {
      skipped += 1;
      continue;
    }
    const channel = await interaction.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      problems.push(`#${ticket.number} (channel gone)`);
      continue;
    }
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    // The closing quote matters: without it listing 5 matches "ls:again:50".
    const marker = `"ls:again:${listing.id}"`;
    const alreadyThere = recent && recent.some(
      (message) => JSON.stringify(message.components || []).includes(marker)
    );
    if (alreadyThere) {
      skipped += 1;
      continue;
    }
    const posted = await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(config.EMBED_COLOR)
        .setTitle('Want to change your offer?')
        .setDescription(`Press the button below to place a new offer on **${listings.displayIgn(listing)}** in this ticket.`)],
      components: [listings.buildOfferAgainRow(listing.id)],
    }).catch(() => null);
    if (posted) added += 1;
    else problems.push(`#${ticket.number} (could not post)`);
  }
  logs.ticket(interaction.client, 'offer buttons refreshed', `<@${interaction.user.id}> added the Offer again control to ${added} ticket(s).`);
  return interaction.editReply({
    content: `Added the Offer again button to **${added}** ticket(s). Skipped ${skipped} (already had one, or the listing is not published).${problems.length ? `\nCould not update: ${problems.slice(0, 10).join(', ')}` : ''}`,
    allowedMentions: { parse: [] },
  });
}

async function handleOffer(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  // Runs across every open ticket, so it takes no ign.
  if (sub === 'refresh') return refreshOfferTickets(interaction);
  const ign = interaction.options.getString('ign').trim();
  const row = db.findListingByIgn(ign);
  if (!row) {
    return interaction.reply({ content: `No request found for **${ign}**.`, flags: EPH });
  }
  const listing = db.parseListing(row);

  if (sub === 'list') {
    const offers = db.offerTicketsForListing(listing.id);
    if (!offers.length) {
      return interaction.reply({ content: `No offers recorded for **${listings.displayIgn(listing)}**. Current best offer: **${listings.displayUsdPrice(listing.co)}**.`, flags: EPH });
    }
    const lines = offers.map((t) => `• <@${t.creator_id}> - **${listings.displayUsdPrice(t.offer_amount)}** (${t.offer_status || 'pending'}, ${t.status}) <#${t.channel_id}>`);
    return interaction.reply({
      content: `Offers on **${listings.displayIgn(listing)}** (current best offer: **${listings.displayUsdPrice(listing.co)}**):\n${lines.join('\n').slice(0, 1800)}`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'set') {
    let amount;
    try {
      amount = listings.normalizeUsdPrice(interaction.options.getString('amount'));
      if (amount === 'Offer') throw new Error('Enter a positive USD amount, or use /offer clear.');
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const updated = db.updateListing(listing.id, { co: amount });
    await listings.renderPublished(interaction.client, updated);
    await listings.renderPreview(interaction.client, updated);
    sync.emitListingUpdate(updated);

    await listings.notifyOutbid(interaction.client, updated, amount).catch(() => {});
    logs.listing(interaction.client, 'best offer changed', listing, interaction.user.id, [
      { name: 'Old', value: listings.displayUsdPrice(listing.co), inline: true },
      { name: 'New', value: amount, inline: true },
    ]);
    return interaction.editReply(`best offer for **${listings.displayIgn(listing)}** set to **${amount}**.`);
  }

  if (sub === 'clear') {
    await interaction.deferReply({ flags: EPH });
    const updated = db.updateListing(listing.id, { co: 'Offer' });
    await listings.renderPublished(interaction.client, updated);
    await listings.renderPreview(interaction.client, updated);
    sync.emitListingUpdate(updated);
    logs.listing(interaction.client, 'best offer cleared', listing, interaction.user.id, [
      { name: 'Old', value: listings.displayUsdPrice(listing.co), inline: true },
    ]);
    return interaction.editReply(`best offer for **${listings.displayIgn(listing)}** reset to **Offer**.`);
  }

  if (sub === 'add') {
    const buyer = interaction.options.getUser('buyer');
    if (buyer.bot) return interaction.reply({ content: 'Bots cannot make offers.', flags: EPH });
    let amount;
    try {
      amount = listings.normalizeUsdPrice(interaction.options.getString('amount'));
      if (amount === 'Offer') throw new Error('Enter a positive USD amount.');
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    const acceptNow = interaction.options.getBoolean('accept') || false;
    // Staff can park the offer on any open ticket instead of the buyer's own
    // offer channel, so one ticket can carry several offers at once.
    const targetChannel = interaction.options.getChannel('ticket');
    if (targetChannel && (targetChannel.guildId !== interaction.guildId || targetChannel.type !== ChannelType.GuildText)) {
      return interaction.reply({ content: 'Choose a text ticket channel from this server.', flags: EPH });
    }
    const targetTicket = targetChannel ? db.getTicketByChannel(targetChannel.id) : null;
    if (targetChannel && !targetTicket) {
      return interaction.reply({ content: `<#${targetChannel.id}> is not an open ticket in this bot.`, flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });

    // Without an explicit ticket, reuse the buyer's existing offer for this
    // listing so they do not collect a new channel for every offer.
    const existing = targetTicket ? null : db.findOfferTicket(listing.id, buyer.id);
    let channel = existing ? await interaction.client.channels.fetch(existing.channel_id).catch(() => null) : null;
    let item;
    let reused = false;
    if (targetTicket) {
      channel = targetChannel;
      item = db.addTicketItem({
        ticketId: targetTicket.id, kind: 'offer', listingId: listing.id,
        offerAmount: amount, offerStatus: acceptNow ? 'accepted' : 'pending',
      });
    } else if (existing && channel) {
      item = db.reviveOfferItem(existing.item_id, amount, acceptNow ? 'accepted' : 'pending');
      reused = true;
      await channelPerms.applyTicketPerms(interaction.guild, channel, buyer.id).catch(() => {});
    } else {
      const created = await tickets.createTicketChannel(interaction.guild, {
        baseName: `${listings.displayIgn(listing)}-offer`,
        categoryKey: 'buy',
        type: 'offer',
        creatorId: buyer.id,
        listingId: listing.id,
        offerAmount: amount,
        offerStatus: acceptNow ? 'accepted' : 'pending',
      });
      channel = created.channel;
      item = created.item;
    }

    const embed = new EmbedBuilder()
      .setColor(acceptNow ? 0x57f287 : config.EMBED_COLOR)
      .setTitle('Offer Review')
      .setDescription(
        `Listing: ${listing.listing_channel_id ? `<#${listing.listing_channel_id}>` : `**${listings.displayIgn(listing)}**`}\n` +
        `Offer: **${amount}**\nBuyer: <@${buyer.id}>\n` +
        `Status: **${acceptNow ? 'Accepted' : 'Waiting for staff approval'}**\nAdded by: <@${interaction.user.id}>`
      );
    // An already-accepted offer needs no review pair, but the buyer should still
    // be able to bid again from the ticket.
    const components = acceptNow
      ? (listing.status === 'published' ? [listings.buildOfferAgainRow(listing.id)] : [])
      : [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ls:oaccept:${listing.id}:${item.item_id}`).setLabel('Accept Offer').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`ls:odecline:${listing.id}:${item.item_id}`).setLabel('Decline Offer').setStyle(ButtonStyle.Danger)
        ),
      ];
    await channel.send({ content: `<@${buyer.id}>`, embeds: [embed], components, allowedMentions: { users: [buyer.id] } }).catch(() => {});

    let note = '';
    if (acceptNow) {
      const updated = db.updateListing(listing.id, { co: amount });
      await listings.renderPublished(interaction.client, updated);
      await listings.renderPreview(interaction.client, updated);
      sync.emitListingUpdate(updated);
      await listings.notifyOutbid(interaction.client, updated, amount, { excludeUserId: buyer.id }).catch(() => {});
      note = ' best offer updated.';
    }
    logs.listing(interaction.client, 'offer added', listing, interaction.user.id, [
      { name: 'Buyer', value: `<@${buyer.id}>`, inline: true },
      { name: 'Amount', value: amount, inline: true },
      { name: 'Ticket', value: `<#${channel.id}>`, inline: true },
    ]);
    return interaction.editReply({
      content: `Recorded **${amount}** from <@${buyer.id}> on **${listings.displayIgn(listing)}** in <#${channel.id}>${reused ? ' (reused their existing offer ticket)' : targetTicket ? ' (added to that ticket)' : ''}.${note}`,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'remove') {
    const buyer = interaction.options.getUser('buyer');
    const ticket = db.findOfferTicket(listing.id, buyer.id);
    if (!ticket) {
      return interaction.reply({ content: `No offer from <@${buyer.id}> on **${listings.displayIgn(listing)}**.`, flags: EPH, allowedMentions: { parse: [] } });
    }
    const resetCo = interaction.options.getBoolean('reset-co') !== false;
    await interaction.deferReply({ flags: EPH });
    db.updateTicketItemOfferStatus(ticket.item_id, 'declined');
    let note = '';
    if (resetCo) {
      const updated = db.updateListing(listing.id, { co: 'Offer' });
      await listings.renderPublished(interaction.client, updated);
      await listings.renderPreview(interaction.client, updated);
      sync.emitListingUpdate(updated);
      note = ' best offer reset to **Offer**.';
    }
    const offerChannel = await interaction.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (offerChannel) {
      await offerChannel.send({
        content: `<@${ticket.creator_id}> your offer of **${listings.displayUsdPrice(ticket.offer_amount)}** was withdrawn by <@${interaction.user.id}>.`,
        components: listing.status === 'published' ? [listings.buildOfferAgainRow(listing.id)] : [],
        allowedMentions: { users: [ticket.creator_id] },
      }).catch(() => {});
    }
    logs.listing(interaction.client, 'offer withdrawn', listing, interaction.user.id, [
      { name: 'Buyer', value: `<@${buyer.id}>`, inline: true },
      { name: 'Amount', value: listings.displayUsdPrice(ticket.offer_amount), inline: true },
    ]);
    return interaction.editReply({
      content: `Withdrew <@${buyer.id}>'s offer of **${listings.displayUsdPrice(ticket.offer_amount)}** on **${listings.displayIgn(listing)}**.${note}`,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleFind(interaction) {
  if (!(await requireStaffOrHigher(interaction))) return;
  const raw = interaction.options.getString('query').trim();
  const user = interaction.options.getUser('user');
  // Accept a channel link, a raw ID, a #mention, a ticket number or a name.
  const linkMatch = raw.match(/channels\/\d+\/(\d+)/);
  const mentionMatch = raw.match(/^<#(\d+)>$/);
  const term = linkMatch ? linkMatch[1] : mentionMatch ? mentionMatch[1] : raw;
  const number = /^#?\d{1,6}$/.test(term) ? parseInt(term.replace('#', ''), 10) : null;

  await interaction.deferReply({ flags: EPH });
  const seen = new Set();
  const listingLines = [];
  const rows = [
    ...db.searchListings(term),
    ...(user ? db.listingsForRequester(user.id) : []),
  ];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const listing = db.parseListing(row);
    if (user && listing.requester_id !== user.id) continue;
    const places = [
      listing.listing_channel_id ? `listing <#${listing.listing_channel_id}>` : null,
      listing.ticket_channel_id ? `ticket <#${listing.ticket_channel_id}>` : null,
    ].filter(Boolean).join(' · ');
    listingLines.push(`• **${listings.displayIgn(listing)}**${listing.ign_hidden ? ` _(${listing.ign})_` : ''} - ${listing.status}, ${listings.displayUsdPrice(listing.bin)} BIN, owner <@${listing.requester_id}>${places ? `\n  ${places}` : ''}`);
  }

  const ticketLines = [];
  const ticketRows = [
    ...db.searchTickets({ term, number }),
    ...(user ? db.searchTickets({ creatorId: user.id }) : []),
  ];
  const ticketSeen = new Set();
  for (const ticket of ticketRows) {
    if (ticketSeen.has(ticket.id)) continue;
    ticketSeen.add(ticket.id);
    if (user && ticket.creator_id !== user.id) continue;
    ticketLines.push(`• #${ticket.number} ${ticket.type} - ${ticket.status}, <#${ticket.channel_id}>, creator <@${ticket.creator_id}>`);
  }

  if (!listingLines.length && !ticketLines.length) {
    return interaction.editReply(`Nothing found for \`${raw}\`.`);
  }
  const sections = [];
  if (listingLines.length) sections.push(`**Listings (${listingLines.length})**\n${listingLines.slice(0, 10).join('\n')}`);
  if (ticketLines.length) sections.push(`**Tickets (${ticketLines.length})**\n${ticketLines.slice(0, 10).join('\n')}`);
  return interaction.editReply({ content: sections.join('\n\n').slice(0, 1900), allowedMentions: { parse: [] } });
}

async function handleAngels(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    let text;
    if (angels.enabled()) {
      text = `Angels API mirror is **on** (${angels.BASE}). Published listings, price changes, sales and deletions are pushed automatically.`;
    } else if (angels.authRejected()) {
      text = 'Angels API mirror is **paused**: the API rejected the key (403 Invalid API key). Fix `ANGELS_API_KEY` and restart me.';
    } else {
      text = 'Angels API mirror is **off** - set `ANGELS_API_KEY` in this server\'s env file and restart me.';
    }
    return interaction.reply({ content: text, flags: EPH });
  }
  if (!angels.enabled()) {
    return interaction.reply({
      content: angels.authRejected()
        ? 'The Angels API rejected the configured key, so the mirror is paused. Fix `ANGELS_API_KEY` and restart me.'
        : 'No Angels API key is configured for this server.',
      flags: EPH,
    });
  }

  if (sub === 'removeall') {
    await interaction.deferReply({ flags: EPH });
    const result = await angels.removeAll();
    logs.send(interaction.client, { title: 'Angels API cleared', description: `by <@${interaction.user.id}>` });
    return interaction.editReply(result.ok
      ? `Removed ${result.body && result.body.removed !== undefined ? result.body.removed : 'all'} listing(s) from the Angels API.`
      : `Angels API rejected that: ${result.status || result.error || 'unknown error'}.`);
  }

  if (sub === 'sync') {
    await interaction.deferReply({ flags: EPH });
    let pushed = 0;
    let failed = 0;
    for (const row of db.listingsForOrganization()) {
      const listing = db.parseListing(row);
      if (!listing.listing_channel_id) continue;
      if (listing.status !== 'published' && listing.status !== 'sold') continue;
      const result = await angels.syncListing(listing);
      if (result.ok) pushed += 1;
      else if (!result.skipped) failed += 1;
    }
    return interaction.editReply(`Pushed ${pushed} listing(s) to the Angels API${failed ? `, ${failed} failed (see logs)` : ''}.`);
  }

  if (sub === 'add') {
    const row = db.findListingByIgn(interaction.options.getString('ign').trim());
    if (!row) return interaction.reply({ content: 'No listing found for that username.', flags: EPH });
    const listing = db.parseListing(row);
    if (!listing.listing_channel_id) {
      return interaction.reply({ content: 'That listing has no public channel yet, so the API has nothing to point at.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const result = await angels.syncListing(listing);
    return interaction.editReply(result.ok
      ? `Pushed **${listings.displayIgn(listing)}** (<#${listing.listing_channel_id}>) to the Angels API.`
      : `Angels API rejected that: ${result.status || result.error || 'unknown error'}.`);
  }

  if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel');
    const ign = interaction.options.getString('ign');
    let channelId = channel ? channel.id : null;
    if (!channelId && ign) {
      const row = db.findListingByIgn(ign.trim());
      channelId = row ? row.listing_channel_id : null;
    }
    if (!channelId) {
      return interaction.reply({ content: 'Give an `ign` with a listing channel, or pick a `channel`.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const result = await angels.removeListing(channelId);
    return interaction.editReply(result.ok
      ? `Removed <#${channelId}> from the Angels API.`
      : `Angels API rejected that: ${result.status || result.error || 'unknown error'}.`);
  }
}

async function handleChannelPerms(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const preset = interaction.options.getString('preset');
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (!channel || channel.guildId !== interaction.guildId) {
    return interaction.reply({ content: 'Choose a channel from this server.', flags: EPH });
  }
  if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({ content: 'I need the **Manage Roles** permission to change channel permissions.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  try {
    await channelPerms.apply(interaction.guild, channel, preset);
    const info = channelPerms.PRESETS[preset];
    logs.send(interaction.client, {
      title: 'Channel permissions changed',
      description: `${channel} set to **${info.label}** by <@${interaction.user.id}>`,
    });
    return interaction.editReply({
      content: `${channel} now uses **${info.label}** - ${info.description}`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    return interaction.editReply(`Could not change permissions: ${err.message}`);
  }
}

// Offers live in the buy category, so there is no separate offer setting.
const TICKET_CATEGORY_KEYS = { proxy: 'cat_proxy', buy: 'cat_buy', support: 'cat_support' };

async function handleCategories(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const lines = [];
    for (const [type, key] of Object.entries(TICKET_CATEGORY_KEYS)) {
      const id = db.getSetting(key);
      lines.push(`• ${type} tickets: ${id ? `<#${id}>` : '_not set_'}`);
    }
    const soldId = db.getSetting('cat_sold');
    lines.push(`• sold listings: ${soldId ? `<#${soldId}>` : '_not set_'}`);
    for (const category of proxyCategories.list()) {
      const id = db.getSetting(`cat_listing_${category.key}`);
      lines.push(`• ${category.label} listings: ${id ? `<#${id}>` : '_not set_'}`);
    }
    return interaction.reply({ content: lines.join('\n').slice(0, 1900), flags: EPH, allowedMentions: { parse: [] } });
  }

  const category = interaction.options.getChannel('category');
  if (!category || category.guildId !== interaction.guildId || category.type !== ChannelType.GuildCategory) {
    return interaction.reply({ content: 'Choose an existing category from this server.', flags: EPH });
  }

  if (sub === 'tickets') {
    const type = interaction.options.getString('type');
    db.setSetting(TICKET_CATEGORY_KEYS[type], category.id);
    return interaction.reply({ content: `${type} tickets will be created in ${category}.`, flags: EPH, allowedMentions: { parse: [] } });
  }

  if (sub === 'sold') return setSoldCategory(interaction, category);

  if (sub === 'listing') {
    const target = proxyCategories.resolve(interaction.options.getString('proxy-category'));
    if (!target) {
      return interaction.reply({
        content: `Unknown proxy category. Use one of: ${proxyCategories.list().map((c) => c.label).join(', ')}`,
        flags: EPH,
      });
    }
    await interaction.deferReply({ flags: EPH });
    db.setSetting(`cat_listing_${target.key}`, category.id);
    await setup.updateListingCategoryVisibility(interaction.guild, category).catch(() => {});
    // Move existing listing channels of that category into the chosen one.
    let moved = 0;
    for (const row of db.listingsForOrganization()) {
      const listing = db.parseListing(row);
      if (listing.category !== target.key || listing.status === 'sold' || !listing.listing_channel_id) continue;
      const channel = await interaction.guild.channels.fetch(listing.listing_channel_id).catch(() => null);
      if (channel && !tickets.inCategoryFamily(channel, category)) {
        const dest = await tickets.categoryWithSpace(interaction.guild, category).catch(() => category);
        await channel.setParent(dest.id, { lockPermissions: false }).catch(() => {});
        moved += 1;
      }
    }
    return interaction.editReply({
      content: `**${target.label}** listings will use ${category}. Moved ${moved} existing channel(s).`,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleLinkFilter(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const domains = linkfilter.allowList();
    return interaction.reply({
      content: `Link filter: **${linkfilter.enabled() ? 'ON' : 'OFF'}**\nAllowed domains (${domains.length}):\n${domains.map((d) => `• \`${d}\``).join('\n') || '_none_'}\n\nStaff and admins are never filtered.`,
      flags: EPH,
    });
  }
  if (sub === 'on' || sub === 'off') {
    linkfilter.setEnabled(sub === 'on');
    if (sub === 'on' && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'Link filter enabled, but I need the **Manage Messages** permission to actually delete links.', flags: EPH });
    }
    return interaction.reply({ content: `Link filter turned **${sub === 'on' ? 'on' : 'off'}**.`, flags: EPH });
  }
  if (sub === 'test') {
    const text = interaction.options.getString('text');
    const bad = linkfilter.findDisallowed(text);
    return interaction.reply({
      content: bad.length ? `Would block: \`${bad.join('`, `')}\`` : 'Nothing in that text would be blocked.',
      flags: EPH,
    });
  }
  const domain = interaction.options.getString('domain');
  try {
    if (sub === 'allow') {
      const added = linkfilter.addDomain(domain);
      return interaction.reply({ content: `Allowed \`${added}\` (subdomains included).`, flags: EPH });
    }
    const removed = linkfilter.removeDomain(domain);
    return interaction.reply({ content: `Removed \`${removed}\` from the allow list.`, flags: EPH });
  } catch (err) {
    return interaction.reply({ content: err.message, flags: EPH });
  }
}

const LOG_KIND_LABELS = {
  audit: { label: 'Audit log', defaultName: 'bot-logs' },
  messages: { label: 'Message log', defaultName: 'message-log' },
  transcripts: { label: 'Ticket transcripts', defaultName: 'transcripts' },
};

async function handleLogChannel(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'show') {
    const lines = Object.entries(LOG_KIND_LABELS).map(([kind, info]) => {
      const id = logs.channelIdFor(kind);
      return `• **${info.label}**: ${id ? `<#${id}>` : '_not set_'}`;
    });
    return interaction.reply({ content: lines.join('\n'), flags: EPH, allowedMentions: { parse: [] } });
  }

  const kind = interaction.options.getString('type');
  const info = LOG_KIND_LABELS[kind] || LOG_KIND_LABELS.audit;

  if (sub === 'disable') {
    db.delSetting(logs.CHANNEL_SETTINGS[kind]);
    return interaction.reply({ content: `${info.label} disabled.`, flags: EPH });
  }

  if (sub === 'create') {
    await interaction.deferReply({ flags: EPH });
    try {
      const name = interaction.options.getString('name') || info.defaultName;
      const { channel: made, created } = await logs.ensureLogChannel(interaction.guild, name, kind);
      await logs.send(interaction.client, {
        kind,
        title: `${info.label} enabled`,
        description: `Set by <@${interaction.user.id}>.`,
      });
      return interaction.editReply({ content: `${created ? 'Created' : 'Reusing'} ${made} for **${info.label}**.`, allowedMentions: { parse: [] } });
    } catch (err) {
      return interaction.editReply(`Could not create the channel: ${err.message}`);
    }
  }

  const channel = interaction.options.getChannel('channel');
  const perms = channel.permissionsFor(interaction.guild.members.me);
  if (!perms || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ViewChannel)) {
    return interaction.reply({ content: `I cannot post in ${channel}. Give me View Channel + Send Messages there.`, flags: EPH });
  }
  if (kind === 'transcripts' && !perms.has(PermissionFlagsBits.AttachFiles)) {
    return interaction.reply({ content: `I need **Attach Files** in ${channel} to post transcripts.`, flags: EPH });
  }
  db.setSetting(logs.CHANNEL_SETTINGS[kind], channel.id);
  await logs.send(interaction.client, { kind, title: `${info.label} enabled`, description: `Set by <@${interaction.user.id}>.` });
  return interaction.reply({ content: `**${info.label}** will go to ${channel}.`, flags: EPH, allowedMentions: { parse: [] } });
}

async function handleEmbed(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased()) {
      return interaction.reply({ content: 'Choose a text channel from this server.', flags: EPH });
    }
    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (!perms || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ViewChannel)) {
      return interaction.reply({ content: `I cannot post in ${channel}. Give me View Channel + Send Messages there.`, flags: EPH });
    }
    return interaction.showModal(embedFlow.buildModal(`em:create:${channel.id}`));
  }

  if (sub === 'edit') {
    const raw = interaction.options.getString('message').trim();
    const link = raw.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    let channelId = interaction.channelId;
    let messageId = raw;
    if (link) {
      if (link[1] !== interaction.guildId) {
        return interaction.reply({ content: 'That message link is from a different server.', flags: EPH });
      }
      [, , channelId, messageId] = link;
    } else if (!/^\d{5,}$/.test(raw)) {
      return interaction.reply({ content: 'Give a message ID (from this channel) or a full message link.', flags: EPH });
    }
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!message) {
      return interaction.reply({ content: 'Could not find that message. Check the ID/link and that I can see the channel.', flags: EPH });
    }
    if (message.author.id !== interaction.client.user.id) {
      return interaction.reply({ content: 'I can only edit embeds that I posted myself.', flags: EPH });
    }
    const existing = message.embeds[0];
    if (!existing) {
      return interaction.reply({ content: 'That message has no embed to edit.', flags: EPH });
    }
    return interaction.showModal(embedFlow.buildModal(`em:edit:${channelId}:${messageId}`, {
      title: existing.title || '',
      description: existing.description || '',
      color: existing.color ? `#${existing.color.toString(16).padStart(6, '0')}` : '',
      image: existing.image ? existing.image.url : '',
      footer: existing.footer ? existing.footer.text : '',
    }));
  }
  return null;
}

async function handleResendEmbed(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const input = interaction.options.getString('message').trim();
  let srcChannelId;
  let messageId;
  const link = input.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (link) {
    if (link[1] !== interaction.guildId) {
      return interaction.reply({ content: 'That message link is from a different server.', flags: EPH });
    }
    [, , srcChannelId, messageId] = link;
  } else if (/^\d{5,}$/.test(input)) {
    srcChannelId = interaction.channelId;
    messageId = input;
  } else {
    return interaction.reply({ content: 'Give a message ID (from this channel) or a full message link.', flags: EPH });
  }
  const target = interaction.options.getChannel('channel') || interaction.channel;
  if (!target || target.guildId !== interaction.guildId || !target.isTextBased()) {
    return interaction.reply({ content: 'Choose a text channel from this server to resend into.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  const srcChannel = await interaction.client.channels.fetch(srcChannelId).catch(() => null);
  const srcMessage = srcChannel && typeof srcChannel.messages?.fetch === 'function'
    ? await srcChannel.messages.fetch(messageId).catch(() => null)
    : null;
  if (!srcMessage) {
    return interaction.editReply('Could not find that message. Check the ID/link and that I can see the channel.');
  }
  // Forwarded messages carry their real content in a snapshot.
  let source = srcMessage;
  if (!srcMessage.content && !(srcMessage.embeds || []).length
      && !(srcMessage.components || []).length && srcMessage.messageSnapshots?.size) {
    source = srcMessage.messageSnapshots.first();
  }
  const perms = target.permissionsFor(interaction.guild.members.me);
  if (!perms || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ViewChannel)) {
    return interaction.editReply(`I cannot post in ${target}. Give me View Channel + Send Messages there.`);
  }
  // "Embed-looking" cards from modern bots are Components V2, not real embeds.
  const isV2 = source.flags && typeof source.flags.has === 'function' && source.flags.has(MessageFlags.IsComponentsV2);
  const components = (source.components || []).map((c) => c.toJSON());
  let what;
  try {
    if (isV2) {
      if (!components.length) {
        return interaction.editReply('That message has nothing I can resend.');
      }
      await target.send({ components, flags: MessageFlags.IsComponentsV2 });
      what = 'card';
    } else {
      const embeds = (source.embeds || []).slice(0, 10).map((embed) => embed.toJSON());
      const content = source.content || '';
      if (!embeds.length && !content && !components.length) {
        return interaction.editReply('That message has nothing I can resend (no text, embed, card, or buttons).');
      }
      await target.send({ content: content || undefined, embeds, components, allowedMentions: { parse: [] } });
      what = [embeds.length ? `${embeds.length} embed(s)` : '', content ? 'text' : '', components.length ? 'buttons' : '']
        .filter(Boolean).join(' + ') || 'content';
    }
  } catch (err) {
    return interaction.editReply(`Could not resend it: ${err.message}`);
  }
  return interaction.editReply({ content: `Resent that message (${what}) in ${target}.`, allowedMentions: { parse: [] } });
}

async function handleSetup(interaction) {
  return setupFlow.start(interaction);
}

async function handleVerify(interaction) {
  if (!(await requireOwner(interaction))) return;
  if (interaction.options.getSubcommand() === 'resend') {
    const channelId = db.getSetting('verify_channel');
    const channel = channelId ? await interaction.client.channels.fetch(channelId).catch(() => null) : null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'No verification channel is configured. Run /setup first.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const message = await channel.send(setup.buildVerificationMessage());
    await message.react(config.VERIFY_EMOJI).catch(() => {});
    db.setSetting('verify_message', message.id);
    return interaction.editReply(`Posted a new verification embed in <#${channel.id}>.`);
  }
  const roleId = db.getSetting('member_role');
  const role = roleId ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
  if (!role) {
    return interaction.reply({ content: 'No verified Member role is configured. Run /setup first.', flags: EPH });
  }
  if (!role.editable) {
    return interaction.reply({ content: 'Move my role above the Member role, then try again.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  const members = await interaction.guild.members.fetch();
  let verified = 0;
  let failed = 0;
  for (const member of members.values()) {
    if (member.user.bot || member.roles.cache.has(role.id)) continue;
    try {
      await member.roles.add(role, 'Owner bulk verification');
      verified += 1;
    } catch (err) {
      failed += 1;
    }
  }
  return interaction.editReply(`Verified ${verified} member(s).${failed ? ` ${failed} could not be updated; check my role hierarchy and permissions.` : ''}`);
}

// The canonical name for a managed ticket: "<account>-proxy-12" for proxy
// tickets with a listing, otherwise "<type>-12".
function wantedTicketName(ticket, base = null) {
  if (base) return tickets.sanitizeChannelName(`${base}-${ticket.number}`);
  const listing = ticket.listing_id ? db.parseListing(db.getListing(ticket.listing_id)) : null;
  if (listing) {
    const label = listing.ign_hidden
      ? (listing.category === 'minecon' ? listings.mineconChannelName(listing) : 'hidden')
      : listing.ign;
    return tickets.sanitizeChannelName(`${label}-${ticket.type}-${ticket.number}`);
  }
  return tickets.sanitizeChannelName(`${ticket.type}-${ticket.number}`);
}

async function renameTicket(interaction) {
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Run this in a ticket channel, or pass the ticket `channel`.', flags: EPH });
  }
  const ticket = db.getTicketByAnyChannel(channel.id);
  if (!ticket) {
    return interaction.reply({ content: `<#${channel.id}> is not a ticket in this bot.`, flags: EPH });
  }
  const wanted = wantedTicketName(ticket, interaction.options.getString('name'));
  if (channel.name === wanted) {
    return interaction.reply({ content: `<#${channel.id}> is already named \`${wanted}\`.`, flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  try {
    await channel.setName(wanted, `Renamed by ${interaction.user.tag}`);
    return interaction.editReply(`Renamed to \`${wanted}\`.`);
  } catch (err) {
    return interaction.editReply(`Could not rename it: ${err.message} (Discord allows two renames per channel per 10 minutes.)`);
  }
}

async function renameAllTickets(interaction) {
  await interaction.deferReply({ flags: EPH });
  const open = db.openTickets();
  let renamed = 0;
  let skipped = 0;
  const failures = [];
  await interaction.editReply(`Renaming ${open.length} open ticket(s)... Discord rate-limits channel renames, so this can take a while.`);
  for (const ticket of open) {
    const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel) continue;
    const wanted = wantedTicketName(ticket);
    if (channel.name === wanted) {
      skipped += 1;
      continue;
    }
    try {
      await channel.setName(wanted, 'Bulk rename to the managed ticket scheme');
      renamed += 1;
    } catch (err) {
      failures.push(`<#${channel.id}>`);
    }
  }
  return interaction.editReply({
    content: `Renamed ${renamed} ticket(s), ${skipped} already correct${failures.length ? `, ${failures.length} failed (rate limit - run it again later): ${failures.slice(0, 10).join(', ')}` : ''}.`,
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

// Moves every open ticket into the category for its type, rolling over to an
// overflow category when one is full.
async function organizeTickets(interaction) {
  const withPerms = interaction.options.getBoolean('permissions') || false;
  await interaction.deferReply({ flags: EPH });
  const open = db.openTickets();
  await interaction.editReply(`Organizing ${open.length} open ticket(s)...`);
  // Fetch the guild's channels once and resolve each category once, instead of
  // refetching per ticket (that is what made this crawl on big servers).
  const allChannels = await interaction.guild.channels.fetch();
  const baseCategories = new Map();
  for (const key of ['proxy', 'buy', 'support']) {
    const base = await tickets.ensureCategory(interaction.guild, key).catch(() => null);
    if (base) baseCategories.set(key, base);
  }
  const counts = {};
  let moved = 0;
  let missingChannels = 0;
  let lastProgress = Date.now();
  let index = 0;
  for (const ticket of open) {
    index += 1;
    const channel = allChannels.get(ticket.channel_id)
      || await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel) {
      missingChannels += 1;
      continue;
    }
    const key = tickets.categoryKeyForType(ticket.type);
    counts[key] = (counts[key] || 0) + 1;
    const base = baseCategories.get(key);
    if (base && !tickets.inCategoryFamily(channel, base)) {
      const target = await tickets.categoryWithSpace(interaction.guild, base, allChannels).catch(() => base);
      const ok = await channel.setParent(target.id, { lockPermissions: false }).then(() => true).catch((err) => {
        console.error(`Could not move ticket #${ticket.number}:`, err.message);
        return false;
      });
      if (ok) moved += 1;
    }
    if (withPerms) await channelPerms.applyTicketPerms(interaction.guild, channel, ticket.creator_id);
    if (Date.now() - lastProgress > 5000) {
      lastProgress = Date.now();
      await interaction.editReply(`Organizing tickets... ${index}/${open.length}`).catch(() => {});
    }
  }
  const breakdown = Object.entries(counts).map(([key, n]) => `${n} ${key}`).join(', ') || 'none';
  const summary = `Moved ${moved} ticket(s) into their categories (${breakdown})${missingChannels ? `, ${missingChannels} channel(s) no longer exist` : ''}${withPerms ? ', permissions re-applied' : ''}.`;
  logs.ticket(interaction.client, 'organize finished', `${summary} Run by <@${interaction.user.id}>.`);
  // The interaction token dies after 15 minutes, so fall back to a channel
  // message when a long run outlives it.
  const edited = await interaction.editReply(summary).then(() => true).catch(() => false);
  if (!edited) {
    await interaction.channel.send({
      content: `<@${interaction.user.id}> ticket organize finished: ${summary}`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch(() => {});
  }
  return null;
}

async function handleTicket(interaction) {
  if (!(await requireStaffOrHigher(interaction))) return;
  const sub = interaction.options.getSubcommand();
  if (sub === 'rename') return renameTicket(interaction);
  if (sub === 'rename-all') return renameAllTickets(interaction);
  if (sub === 'organize') return organizeTickets(interaction);
  const channel = interaction.options.getChannel('channel');
  if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Choose an existing text ticket channel from this server.', flags: EPH });
  }
  if (db.getTicketByAnyChannel(channel.id)) {
    return interaction.reply({ content: 'That ticket is already managed by this bot.', flags: EPH });
  }
  // Owner inference fetches members, so acknowledge before doing it.
  await interaction.deferReply({ flags: EPH });
  const creatorId = await inferTicketOwner(interaction, channel, interaction.options.getUser('owner'));
  if (!creatorId) {
    return interaction.editReply('I could not infer one ticket owner. Run it again with the optional `owner` user.');
  }
  const type = interaction.options.getString('type') || 'support';
  const { ticket } = await tickets.takeOverTicketChannel(interaction.guild, channel, { type, creatorId });
  logs.ticket(interaction.client, 'imported', `Ticket #${ticket.number} in <#${channel.id}> taken over by <@${interaction.user.id}> (type: ${type}).`);
  if (type !== 'proxy') {
    return interaction.editReply({ content: `Ticket #${ticket.number} is now managed by this bot. Existing TicketsBot content and permissions were kept.` });
  }
  // A proxy import needs the account details re-entered so the listing card and
  // its Mark Sold control can be rebuilt in the imported ticket.
  const listingChannel = interaction.options.getChannel('listing-channel');
  if (listingChannel && (listingChannel.guildId !== interaction.guildId || listingChannel.type !== ChannelType.GuildText)) {
    return interaction.editReply('Choose an existing text channel from this server as the listing channel.');
  }
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(config.EMBED_COLOR)
        .setTitle('Finish importing this request')
        .setDescription(
          `<@${interaction.user.id}> please re-enter this account's details (username, category, capes, bans/history, prices).\n` +
          `${listingChannel ? `The existing listing channel <#${listingChannel.id}> will be reused.` : 'A listing channel will be created when staff accept it.'}`
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`imp:start:${ticket.id}:${listingChannel ? listingChannel.id : 'none'}`)
          .setLabel('Enter account details')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('📝')
      ),
    ],
    allowedMentions: { users: [interaction.user.id] },
  });
  return interaction.editReply({
    content: `Ticket #${ticket.number} is now managed by this bot. Press **Enter account details** in <#${channel.id}> to rebuild the listing${listingChannel ? ` (reusing <#${listingChannel.id}>)` : ''}.`,
  });
}

const handlers = {
  request: handleProxy,
  panel: handlePanel,
  close: handleClose,
  inactive: handleInactive,
  add: handleAdd,
  crypto: handleCrypto,
  setwallet: handleSetWallet,
  wallet: handleWallet,
  giveaway: handleGiveaway,
  invites: handleInvites,
  pingroles: handlePingRoles,
  link: handleLink,
  offer: handleOffer,
  budget: handleBin,
  categories: handleCategories,
  find: handleFind,
  angels: handleAngels,
  channelperms: handleChannelPerms,
  linkfilter: handleLinkFilter,
  logchannel: handleLogChannel,
  transcript: handleTranscript,
  backup: handleBackup,
  recover: handleRecover,
  embed: handleEmbed,
  resendembed: handleResendEmbed,
  role: handleRole,
  vouch: handleVouch,
  setup: handleSetup,
  verify: handleVerify,
  ticket: handleTicket,
};

// Renders the command exactly as it was invoked, e.g. "/proxy hide ign:Notch".
function describeInvocation(interaction) {
  const parts = [`/${interaction.commandName}`];
  let options = interaction.options.data;
  while (options && options.length && (options[0].type === 1 || options[0].type === 2)) {
    parts.push(options[0].name);
    options = options[0].options || [];
  }
  for (const option of options || []) {
    let value = option.value;
    if (option.user) value = `@${option.user.tag}`;
    else if (option.channel) value = `#${option.channel.name}`;
    else if (option.role) value = `@${option.role.name}`;
    parts.push(`${option.name}:${String(value).slice(0, 80)}`);
  }
  return parts.join(' ');
}

async function dispatch(interaction) {
  const handler = handlers[interaction.commandName];
  if (!handler) {
    return interaction.reply({ content: 'Unknown command.', flags: EPH });
  }
  // The audit entry is written only after the command has been acknowledged.
  // Logging first would queue a REST call ahead of the interaction reply and
  // could push it past Discord's three second window ("Unknown interaction").
  const audit = (title, extra = '', color = config.EMBED_COLOR) => {
    setImmediate(() => {
      logs.send(interaction.client, {
        title,
        description: `\`${describeInvocation(interaction)}\`\nBy <@${interaction.user.id}> in <#${interaction.channelId}>${extra}`,
        color,
      }).catch(() => {});
    });
  };
  try {
    const result = await handler(interaction);
    audit('Command used');
    return result;
  } catch (err) {
    audit('Command failed', `\n\`\`\`${String(err.message).slice(0, 500)}\`\`\``, 0xed4245);
    throw err;
  }
}

module.exports = { dispatch };
