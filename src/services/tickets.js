const {
  ChannelType, PermissionFlagsBits, OverwriteType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, StringSelectMenuBuilder,
} = require('discord.js');
const db = require('../db');
const { EMBED_COLOR, CLOSE_DEFAULT_MS, STAFF_ROLE_ID } = require('../config');
const { formatDuration } = require('../util/time');
const autodelete = require('./autodelete');

const CATEGORY_SETTING_KEYS = {
  proxy: 'cat_proxy',
  buy: 'cat_buy',
  support: 'cat_support',
  offer: 'cat_offer',
};
const CATEGORY_NAMES = {
  proxy: require('../config').CAT_PROXY,
  buy: require('../config').CAT_BUY,
  support: require('../config').CAT_SUPPORT,
  offer: 'Offer Tickets',
};

// Offers and BIN purchases are both buying, so they share the Buy Tickets
// category rather than splitting the sidebar.
function categoryKeyForType(type) {
  if (type === 'offer' || type === 'bin') return 'buy';
  return CATEGORY_SETTING_KEYS[type] ? type : 'support';
}

function sanitizeChannelName(name) {
  const cleaned = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
  return cleaned || 'ticket';
}

// Listing channels may contain emojis and unicode in their names,
// e.g. "💎┃ario_m". Only strips what Discord cannot handle.
function sanitizeListingChannelName(name) {
  const cleaned = String(name)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}_\-|┃│•~]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 95);
  return cleaned || 'listing';
}

// The bot must grant itself access to the private channels it creates, so
// everything keeps working even when it was invited without Administrator.
function botOverwrite(guild) {
  return {
    id: guild.members.me.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ],
    type: OverwriteType.Member,
  };
}

async function ensureCategory(guild, key) {
  const settingKey = CATEGORY_SETTING_KEYS[key];
  const storedId = db.getSetting(settingKey);
  if (storedId) {
    const existing = guild.channels.cache.get(storedId) ||
      (await guild.channels.fetch(storedId).catch(() => null));
    if (existing) return existing;
  }
  const existingByName = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === CATEGORY_NAMES[key].toLowerCase()
  );
  if (existingByName) {
    db.setSetting(settingKey, existingByName.id);
    return existingByName;
  }
  const category = await guild.channels.create({
    name: CATEGORY_NAMES[key],
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      botOverwrite(guild),
    ],
  });
  db.setSetting(settingKey, category.id);
  return category;
}

const DISCORD_CATEGORY_LIMIT = 50;

// Discord allows at most 50 channels per category. When one fills up, roll over
// to a sibling ("Proxy Tickets 2", "Proxy Tickets 3", ...) instead of failing.
async function categoryWithSpace(guild, category, prefetched = null) {
  if (!category) return null;
  // Bulk operations pass the channel list in so they do not refetch the whole
  // guild for every single channel they touch.
  const channels = prefetched || await guild.channels.fetch();
  const countIn = (id) => channels.filter((channel) => channel && channel.parentId === id).size;
  if (countIn(category.id) < DISCORD_CATEGORY_LIMIT) return category;

  const baseName = category.name.replace(/\s+\d+$/, '');
  for (let index = 2; index <= 20; index += 1) {
    const wantedName = `${baseName} ${index}`;
    const existing = channels.find(
      (channel) => channel && channel.type === ChannelType.GuildCategory &&
        channel.name.toLowerCase() === wantedName.toLowerCase()
    );
    if (existing) {
      if (countIn(existing.id) < DISCORD_CATEGORY_LIMIT) return existing;
      continue;
    }
    const overflow = await guild.channels.create({
      name: wantedName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [...category.permissionOverwrites.cache.values()].map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.toArray(),
        deny: overwrite.deny.toArray(),
      })),
    });
    console.log(`Category "${category.name}" was full, created overflow category "${wantedName}".`);
    return overflow;
  }
  return category;
}

// True when the channel already sits in the base category or any of its
// overflow siblings ("Name", "Name 2", "Name 3", ...).
function inCategoryFamily(channel, baseCategory) {
  if (!channel || !baseCategory || !channel.parent) return false;
  if (channel.parentId === baseCategory.id) return true;
  const base = baseCategory.name.replace(/\s+\d+$/, '').toLowerCase();
  const parent = channel.parent.name.replace(/\s+\d+$/, '').toLowerCase();
  return base === parent;
}

// Creates a private ticket channel plus its DB row.
async function createTicketChannel(guild, {
  baseName, categoryKey, type, creatorId, extraUserIds = [], listingId = null,
  offerAmount = null, offerStatus = null,
}) {
  const number = db.nextTicketNumber();
  const category = await categoryWithSpace(guild, await ensureCategory(guild, categoryKey));
  const memberPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    botOverwrite(guild),
    { id: creatorId, allow: memberPerms, type: OverwriteType.Member },
  ];
  const staffRole = STAFF_ROLE_ID ? guild.roles.cache.get(STAFF_ROLE_ID) : null;
  if (staffRole) {
    overwrites.push({ id: staffRole.id, allow: memberPerms, type: OverwriteType.Role });
  }
  for (const userId of new Set(extraUserIds)) {
    if (userId !== creatorId) {
      overwrites.push({ id: userId, allow: memberPerms, type: OverwriteType.Member });
    }
  }
  const channel = await guild.channels.create({
    name: sanitizeChannelName(`${baseName}-${number}`),
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
  });
  const ticket = db.createTicket({ number, channelId: channel.id, type, creatorId, listingId, offerAmount, offerStatus });
  require('./logs').ticket(guild.client, 'opened', `#${number} ${type} - <#${channel.id}> for <@${creatorId}>${offerAmount ? ` (offer ${offerAmount})` : ''}`);
  return { channel, ticket, item: db.firstTicketItem(ticket.id) };
}

// Lets someone park a new proxy, offer or BIN on a ticket they already have
// open instead of collecting one channel per action.
function ticketPickerRow(customId, guild, rows, placeholder = 'Pick a ticket') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(
        { label: 'Create a new ticket', value: 'new', emoji: '➕' },
        ...rows.slice(0, 24).map((row) => {
          const channel = guild.channels.cache.get(row.channel_id);
          return {
            label: `#${row.number} · ${channel ? channel.name : row.type}`.slice(0, 100),
            description: `Add it to this open ${row.type} ticket`.slice(0, 100),
            value: String(row.id),
          };
        })
      )
  );
}

// Imports a channel created by TicketsBot (or another ticket bot) without
// moving it, deleting its messages, or replacing its existing overwrites.
// The new bot adds only its own access and a new close control message.
async function takeOverTicketChannel(guild, channel, {
  type = 'support', creatorId, listingId = null, sendWelcome = true,
  rename = true, renameBase = null,
} = {}) {
  if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
    throw new Error('Choose a text channel from this server.');
  }
  const existing = db.getTicketByAnyChannel(channel.id);
  if (existing) return { channel, ticket: existing, alreadyManaged: true };

  await channel.permissionOverwrites.edit(guild.members.me, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageMessages: true,
    AddReactions: true,
    EmbedLinks: true,
    AttachFiles: true,
  });
  const number = db.nextTicketNumber();
  const ticket = db.createTicket({ number, channelId: channel.id, type, creatorId, listingId });
  // Imported tickets keep third-party names like "ticket-0042"; rename them to
  // this bot's scheme so every managed ticket reads the same in the sidebar.
  if (rename) {
    const base = renameBase || type;
    const wanted = sanitizeChannelName(`${base}-${number}`);
    if (channel.name !== wanted) {
      await channel.setName(wanted, 'Renamed to the managed ticket scheme').catch((err) => {
        console.error(`Could not rename imported ticket #${number}:`, err.message);
      });
    }
  }
  if (sendWelcome) {
    await sendTicketWelcome(
      channel,
      ticket,
      'This existing ticket is now managed by this bot. Its earlier TicketsBot messages and permissions were kept. Use the button below or `/close` to close it with the new system.'
    );
  }
  return { channel, ticket, alreadyManaged: false };
}

function closeButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk:closebtn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );
}

async function sendTicketWelcome(channel, ticket, description) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Ticket #${ticket.number}`)
    .setDescription(description);
  await channel.send({ embeds: [embed], components: [closeButtonRow()] });
  const ping = await channel.send({ content: `<@${ticket.creator_id}>` });
  autodelete.registerPingDelete(ping, ticket.creator_id);
}

// The forced-close notice has no "keep open" control; only staff can expedite.
function forcedPromptPayload(ticket, closeAt) {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('Ticket closing')
    .setDescription(`This ticket will close <t:${Math.floor(closeAt / 1000)}:R> and cannot be cancelled.`);
  // No controls: staff close early with `/close now:true`.
  return { content: `<@${ticket.creator_id}>`, embeds: [embed], components: [], allowedMentions: { users: [ticket.creator_id] } };
}

// Posts the "do you want to close this?" prompt and schedules the auto close.
// A forced close cannot be cancelled by the creator or by new messages.
async function startClosePrompt(channel, ticket, requestedById, ms, { forced = false, keepListing = false } = {}) {
  const timeout = ms || CLOSE_DEFAULT_MS;
  const existing = db.getPendingClose(channel.id);
  if (existing) {
    // Upgrading an existing pending close to forced makes it un-cancellable.
    if (forced && !existing.forced) {
      db.upsertPendingClose(channel.id, ticket.id, existing.prompt_message_id, existing.close_at, 1, existing.keep_listing);
      if (existing.prompt_message_id) {
        const prompt = await channel.messages.fetch(existing.prompt_message_id).catch(() => null);
        if (prompt) await prompt.edit(forcedPromptPayload(ticket, existing.close_at)).catch(() => {});
      }
      return { alreadyPending: false, forced: true, closeAt: existing.close_at, timeoutText: formatDuration(Math.max(0, existing.close_at - Date.now())) };
    }
    return { alreadyPending: true, closeAt: existing.close_at, forced: Boolean(existing.forced) };
  }
  const closeAt = Date.now() + timeout;
  let prompt;
  if (forced) {
    prompt = await channel.send(forcedPromptPayload(ticket, closeAt));
  } else {
    // Force close lives in `/close now:true` now, so the prompt only offers the
    // creator's two choices.
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cl:yes:${ticket.id}`).setLabel('Close it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cl:no:${ticket.id}`).setLabel('Keep it open').setStyle(ButtonStyle.Secondary)
    );
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Close this ticket?')
      .setDescription(
        `<@${requestedById}> wants to close this ticket.\n` +
        `If you do not respond, it closes automatically <t:${Math.floor(closeAt / 1000)}:R>.`
      );
    prompt = await channel.send({
      content: `<@${ticket.creator_id}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [ticket.creator_id] },
    });
  }
  db.upsertPendingClose(channel.id, ticket.id, prompt.id, closeAt, forced ? 1 : 0, keepListing ? 1 : 0);
  return { alreadyPending: false, forced, closeAt, timeoutText: formatDuration(timeout) };
}

// When a ticket that owns a listing closes, the listing must not be left
// dangling: a channel that carries a published card becomes SOLD, one that
// never got a card is removed entirely. Either way it leaves the Angels API.
// A ticket can host several proxies at once, so each one it owns is finalised.
// Only proxy items own their listing; buy, BIN and offer items merely reference
// one, so closing a ticket must never sell or delete through those.
async function finalizeListingForClosedTicket(client, ticket, reason) {
  const owned = new Set(
    db.ticketItems(ticket.id)
      .filter((item) => item.kind === 'proxy' && item.listing_id)
      .map((item) => item.listing_id)
  );
  for (const listingId of owned) {
    await finalizeOneListing(client, ticket, listingId, reason);
  }
}

async function finalizeOneListing(client, ticket, listingId, reason) {
  const listings = require('./listings');
  const angels = require('./angels');
  const sync = require('./sync');
  const logs = require('./logs');
  const row = db.getListing(listingId);
  const listing = row ? db.parseListing(row) : null;
  if (!listing || listing.status === 'deleted' || listing.status === 'sold') return;

  const channel = listing.listing_channel_id
    ? await client.channels.fetch(listing.listing_channel_id).catch(() => null)
    : null;
  const card = channel && listing.listing_message_id
    ? await channel.messages.fetch(listing.listing_message_id).catch(() => null)
    : null;

  if (card) {
    const updated = db.updateListing(listing.id, { status: 'sold' });
    await listings.renderPublished(client, updated).catch(() => {});
    const guild = channel.guild;
    if (guild) await require('./setup').organizeListing(guild, updated).catch(() => {});
    sync.emitListingUpdate(updated); // marks sold then removes it from Angels
    logs.listing(client, 'marked sold (ticket closed)', listing, null, [
      { name: 'Ticket', value: `#${ticket.number}`, inline: true },
      { name: 'Reason', value: String(reason).slice(0, 100), inline: true },
    ]);
    return;
  }

  // No published card: drop the listing and its channel.
  if (listing.listing_channel_id) {
    await angels.removeListing(listing.listing_channel_id).catch(() => {});
    if (channel) await channel.delete(`Listing removed: ticket #${ticket.number} closed`).catch(() => {});
  }
  const removed = db.updateListing(listing.id, { status: 'deleted' });
  sync.emitListingUpdate(removed);
  logs.listing(client, 'deleted (ticket closed without a published card)', listing, null, [
    { name: 'Ticket', value: `#${ticket.number}`, inline: true },
  ]);
}

async function performClose(client, ticket, reason, { silent = false, keepListing = false } = {}) {
  db.removePendingClose(ticket.channel_id);
  db.removeInactivityWatch(ticket.channel_id);
  db.markTicketClosed(ticket.id);
  // keepListing leaves the connected proxy exactly as it is: not sold, not
  // deleted, its channel untouched.
  if (!keepListing) {
    await finalizeListingForClosedTicket(client, ticket, reason).catch((err) => console.error('Listing finalisation failed:', err.message));
  }
  require('./logs').ticket(client, 'closed', `#${ticket.number} ${ticket.type} - <#${ticket.channel_id}>, creator <@${ticket.creator_id}> (${reason})${silent ? ' [silent]' : ''}`);
  try {
    const channel = await client.channels.fetch(ticket.channel_id);
    if (!channel) return;
    // Save and DM the transcript while the channel still exists.
    const archived = await require('./transcripts').archive(client, channel, ticket).catch((err) => {
      console.error('Transcript archive failed:', err.message);
      return null;
    });
    if (archived && archived.messages) {
      require('./logs').ticket(client, 'transcript saved', `#${ticket.number} - ${archived.messages} message(s)${archived.saved ? ', archived' : ''}${archived.dmed ? `, DMed to <@${ticket.creator_id}>` : ', DM not delivered'}.`);
    }
    // A silent close skips the countdown notice and just removes the channel.
    if (silent) {
      await channel.delete(`Ticket #${ticket.number} closed: ${reason}`).catch(() => {});
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setDescription(`🔒 Closing this ticket (${reason}) in 5 seconds.`);
    await channel.send({ embeds: [embed] }).catch(() => {});
    setTimeout(() => {
      channel.delete(`Ticket #${ticket.number} closed: ${reason}`).catch(() => {});
    }, 5000);
  } catch (err) {
    // channel already deleted
  }
}

// Acts on tickets whose inactivity window has elapsed. Nothing is posted while
// the window runs, so the watch is invisible until it fires; what happens then
// depends on the watch's action (close request, forced close, or close now).
async function sweepInactivity(client) {
  for (const watch of db.dueInactivityWatches(Date.now())) {
    const ticket = db.getTicket(watch.ticket_id);
    if (!ticket || ticket.status !== 'open') {
      db.removeInactivityWatch(watch.channel_id);
      continue;
    }
    const window = formatDuration(watch.timeout_ms);
    try {
      if (watch.action === 'now') {
        await performClose(client, ticket, `no activity for ${window}`, { silent: Boolean(watch.silent) });
        continue; // performClose clears the watch
      }
      const channel = await client.channels.fetch(watch.channel_id).catch(() => null);
      if (!channel) {
        db.removeInactivityWatch(watch.channel_id);
        continue;
      }
      // The window is over: ask the creator the normal way (or force it).
      await startClosePrompt(channel, ticket, watch.armed_by || client.user.id, watch.close_ms || null, {
        forced: watch.action === 'force',
      });
      db.removeInactivityWatch(watch.channel_id);
      require('./logs').ticket(client, 'inactivity triggered', `#${ticket.number} in <#${watch.channel_id}> had no activity for ${window}; ${watch.action === 'force' ? 'a forced close' : 'a close request'} was sent.`);
    } catch (err) {
      console.error('Inactivity action failed:', err.message);
    }
  }
}

async function cancelClose(channelOrId, reason = null) {
  const channelId = typeof channelOrId === 'string' ? channelOrId : channelOrId.id;
  const pending = db.getPendingClose(channelId);
  if (!pending) return false;
  if (pending.forced) return false; // forced closes cannot be cancelled
  db.removePendingClose(channelId);
  if (reason && typeof channelOrId !== 'string' && pending.prompt_message_id) {
    const prompt = await channelOrId.messages.fetch(pending.prompt_message_id).catch(() => null);
    if (prompt) {
      await prompt.edit({
        content: reason,
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }
  return true;
}

async function sweepCloses(client) {
  const rows = db.duePendingCloses(Date.now());
  for (const row of rows) {
    const ticket = db.getTicket(row.ticket_id);
    db.removePendingClose(row.channel_id);
    if (ticket && ticket.status === 'open') {
      await performClose(client, ticket, 'no response in time', { keepListing: Boolean(row.keep_listing) });
    }
  }
}

module.exports = {
  sanitizeChannelName, sanitizeListingChannelName, botOverwrite, ensureCategory, categoryWithSpace, inCategoryFamily, categoryKeyForType, createTicketChannel, takeOverTicketChannel,
  sendTicketWelcome, closeButtonRow, ticketPickerRow,
  startClosePrompt, performClose, cancelClose, sweepCloses, sweepInactivity,
};
