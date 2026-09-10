const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const state = require('../util/state');
const db = require('../db');
const config = require('../config');
const capes = require('../services/capes');
const listings = require('../services/listings');
const tickets = require('../services/tickets');
const proxyCategories = require('../services/proxyCategories');
const sync = require('../services/sync');
const logs = require('../services/logs');

const EPH = MessageFlags.Ephemeral;

// Buttons shown next to an error, so a retry reopens the modal with everything
// the buyer already typed still in it.
function retryRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pw:ignretry').setLabel('Edit again').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
}

function detailsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pw:cont').setLabel('Add details').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('pw:ignretry').setLabel('Edit again').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
}

async function startWizard(interaction, options = {}) {
  const existing = state.get(interaction.user.id);
  state.set(interaction.user.id, {
    step: 'category',
    ownerId: options.ownerId || interaction.user.id,
    // Titles are always public; there is no hide option any more.
    ignHidden: false,
    suppressProxyNotice: Boolean(options.suppressProxyNotice),
    hideProxyLabel: Boolean(options.hideProxyLabel),
    // Whatever was typed last time, so a reopened modal is never blank.
    raw: (existing && existing.raw) || {},
    capes: (existing && existing.capes) || [],
    // Set when importing an existing (third-party) ticket: the request is bound
    // to that channel instead of a freshly created one.
    boundTicketChannelId: options.boundTicketChannelId || null,
    boundTicketId: options.boundTicketId || null,
    // Optional existing public request channel to reuse instead of creating one.
    boundListingChannelId: options.boundListingChannelId || null,
  });
  return interaction.reply({
    content: 'Let us post what you are looking for. First, pick the section it belongs in.',
    components: [listings.buildCategorySelectRow('pw:cat')],
    flags: EPH,
  });
}

function expired(interaction) {
  return interaction
    .reply({ content: 'This flow expired. Press Create Request to start again.', flags: EPH })
    .catch(() => {});
}

// Discord caps message content at 2000 characters. Cape lines use custom emoji
// (~35 characters each), so a long selection has to be trimmed to fit.
function fitCapeLine(line, budget) {
  if (line.length <= budget) return line;
  const parts = line.split('  ');
  const kept = [];
  let used = 0;
  for (const part of parts) {
    if (used + part.length + 2 > budget - 20) break;
    kept.push(part);
    used += part.length + 2;
  }
  const hidden = parts.length - kept.length;
  return `${kept.join('  ')}${hidden > 0 ? `  _+${hidden} more_` : ''}`;
}

function capeStepPayload(data) {
  const line = capes.capeLine(data.capes);
  const heading = data.capes.length
    ? `Capes **${data.ign}** should ideally have:`
    : `Which capes should **${data.ign}** ideally have?`;
  const instructions = '\n\nPick them with the menus, then press Continue. Leave it empty if capes do not matter.';
  const fixed = `${heading}\n${instructions}`;
  return {
    content: `${heading}\n${fitCapeLine(line, 1990 - fixed.length)}${instructions}`,
    components: [
      ...listings.buildCapeSelectRows('pw:capes', data.capes),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pw:cont').setLabel('Continue').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('pw:ignretry').setLabel('Edit again').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

// The optional catch-all step: every field the kind's own modal did not ask
// for, so nothing is impossible to describe.
function extraStepPayload(data, lead = 'Details saved. Add anything else, or post the request.') {
  return {
    content: `${lead}\nChannel name: **#${data.channelName}**`,
    components: [
      listings.buildExtraFieldRow('pw:more', data.category, data.info),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pw:post').setLabel('Post request').setStyle(ButtonStyle.Success).setEmoji('📨'),
        new ButtonBuilder().setCustomId('pw:chan').setLabel('Channel name').setStyle(ButtonStyle.Secondary).setEmoji('🏷️'),
        new ButtonBuilder().setCustomId('pw:cont').setLabel('Edit details').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ],
    flags: EPH,
  };
}

// Warns staff in the ticket when the same account is already listed, which
// usually means two people are proxying it (or the owner forgot an old listing).
async function warnIfDuplicate(client, channel, listing) {
  try {
    const duplicates = db.findDuplicateListings({
      uuid: listing.uuid || null,
      ign: listing.ign,
      excludeId: listing.id,
    });
    if (!duplicates.length) return false;
    const lines = duplicates.slice(0, 5).map((row) => {
      const other = db.parseListing(row);
      const where = other.listing_channel_id
        ? `<#${other.listing_channel_id}>`
        : other.ticket_channel_id ? `ticket <#${other.ticket_channel_id}>` : 'no channel yet';
      return `• ${where} - status **${other.status}**, owner <@${other.requester_id}>`;
    });
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('⚠️ Similar request already open')
      .setDescription(
        `**${listing.ign}** is already being looked for ${duplicates.length} other time(s). Check for a duplicate before accepting.\n\n${lines.join('\n')}`
      );
    await channel.send({
      content: config.STAFF_ROLE_ID ? `<@&${config.STAFF_ROLE_ID}>` : '',
      embeds: [embed],
      allowedMentions: config.STAFF_ROLE_ID ? { roles: [config.STAFF_ROLE_ID] } : { parse: [] },
    }).catch(() => {});
    logs.send(client, {
      title: 'Duplicate request detected',
      description: `**${listing.ign}** was requested again in <#${channel.id}> while ${duplicates.length} active request(s) already exist.`,
      color: 0xed4245,
    });
    return true;
  } catch (err) {
    console.error('Duplicate check failed:', err.message);
    return false;
  }
}

async function createProxyTicket(interaction, data) {
  const guild = interaction.guild;
  const listing = db.createListing({
    ign: data.ign,
    uuid: data.uuid,
    category: data.category,
    capes: data.capes,
    info: data.info,
    co: data.co,
    bin: data.bin,
    requesterId: data.ownerId,
    nameSuggestion: data.channelName || null,
    ignHidden: data.ignHidden,
    hideProxyLabel: data.hideProxyLabel,
  });
  // An imported ticket keeps its existing channel; otherwise create a new one.
  let channel;
  let ticket;
  if (data.boundTicketChannelId) {
    channel = await guild.channels.fetch(data.boundTicketChannelId).catch(() => null);
    ticket = data.boundTicketId ? db.getTicket(data.boundTicketId) : db.getTicketByChannel(data.boundTicketChannelId);
    if (!channel || !ticket) throw new Error('The imported ticket channel is no longer available.');
    const { primary } = db.attachListingToTicket(ticket.id, listing.id);
    // Only the first proxy on a ticket names its channel. A second one joining
    // an existing ticket must not rename it out from under the first.
    if (primary) {
      const wanted = tickets.sanitizeChannelName(`${data.ign}-request-${ticket.number}`);
      if (channel.name !== wanted) {
        await channel.setName(wanted, 'Imported request ticket named after what it looks for').catch((err) => {
          console.error('Could not rename imported request ticket:', err.message);
        });
      }
    }
  } else {
    ({ channel, ticket } = await tickets.createTicketChannel(guild, {
      baseName: `${data.ign}-request`,
      categoryKey: 'proxy',
      type: 'proxy',
      creatorId: data.ownerId,
      listingId: listing.id,
    }));
  }
  if (data.boundListingChannelId) db.updateListing(listing.id, { listing_channel_id: data.boundListingChannelId });
  const mentions = [];
  const pingUsers = [];
  const pingRoles = [];
  if (config.OWNER_ID) {
    mentions.push(`<@${config.OWNER_ID}>`);
    pingUsers.push(config.OWNER_ID);
  }
  if (config.STAFF_ROLE_ID) {
    mentions.push(`<@&${config.STAFF_ROLE_ID}>`);
    pingRoles.push(config.STAFF_ROLE_ID);
  }
  if (!data.suppressProxyNotice) {
    await channel.send({
      content: `${mentions.join(' ')} new account request from <@${data.ownerId}>`,
      allowedMentions: { users: pingUsers, roles: pingRoles },
    });
  }
  const withId = { ...db.parseListing(listing), id: listing.id };
  const preview = await channel.send(listings.listingPayload(withId, 'preview', { revealIgn: true }));
  const stored = db.updateListing(listing.id, {
    ticket_channel_id: channel.id,
    preview_message_id: preview.id,
  });
  sync.emitListingUpdate(stored);
  // One close control per ticket. Imported/attached tickets already received
  // theirs from the takeover welcome, so only fresh channels get one here. The
  // listing card itself carries Mark Sold once the listing is accepted.
  if (!data.boundTicketChannelId) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(config.EMBED_COLOR)
          .setDescription('Staff will review this request. Add more details or screenshots below.'),
      ],
      components: [tickets.closeButtonRow()],
    });
  }
  logs.listing(interaction.client, 'created', db.parseListing(stored), data.ownerId, [
    { name: 'Ticket', value: `<#${channel.id}>`, inline: true },
    { name: 'Category', value: String(data.category), inline: true },
  ]);
  await warnIfDuplicate(interaction.client, channel, db.parseListing(stored));
  return { channel, ticket };
}

async function finishProxy(interaction, data) {
  const { channel } = await createProxyTicket(interaction, data);
  state.clear(interaction.user.id);
  return interaction.editReply({
    content: `${data.suppressProxyNotice ? 'Request review ticket created' : 'Your request was submitted'}: <#${channel.id}>. Staff will review it soon.`,
    components: [],
  });
}

// Entry point for "Enter account details" on an imported third-party ticket.
async function startImport(interaction, parts) {
  const ticket = db.getTicket(parseInt(parts[2], 10));
  if (!ticket || ticket.status !== 'open') {
    return interaction.reply({ content: 'That imported ticket is no longer open.', flags: EPH });
  }
  if (ticket.listing_id) {
    return interaction.reply({ content: 'This ticket already has a request attached.', flags: EPH });
  }
  const listingChannelId = parts[3] && parts[3] !== 'none' ? parts[3] : null;
  return startWizard(interaction, {
    ownerId: ticket.creator_id,
    suppressProxyNotice: true,
    boundTicketChannelId: ticket.channel_id,
    boundTicketId: ticket.id,
    boundListingChannelId: listingChannelId,
  });
}

async function handle(interaction, parts) {
  if (parts[0] === 'imp') return startImport(interaction, parts);
  const action = parts[0] === 'panel' ? 'start' : parts[1];

  if (action === 'start') return startWizard(interaction);

  const data = state.get(interaction.user.id);

  if (action === 'cat') {
    if (!data) return expired(interaction);
    const category = proxyCategories.resolve(interaction.values[0]);
    if (!category) return expired(interaction);
    data.category = category.key;
    return interaction.showModal(listings.buildBasicsModal('pw:ign', data.raw));
  }

  if (action === 'ignretry') {
    if (!data) return expired(interaction);
    return interaction.showModal(listings.buildBasicsModal('pw:ign', data.raw));
  }

  if (action === 'ign') {
    if (!data) return expired(interaction);
    // Store the raw input first: any error below reopens the modal with it.
    data.raw = {
      ign: interaction.fields.getTextInputValue('ign').trim(),
      description: interaction.fields.getTextInputValue('description').trim(),
      budget: interaction.fields.getTextInputValue('budget').trim(),
      amount: interaction.fields.getTextInputValue('amount').trim(),
    };
    if (!data.category) return expired(interaction);
    if (!data.raw.ign) {
      return interaction.reply({
        content: 'Write a short title, for example `3-letter OG name` or `Migrator cape account`.',
        components: [retryRow()],
        flags: EPH,
      });
    }
    let budget;
    try {
      budget = listings.parseBudgetRange(data.raw.budget);
    } catch (err) {
      return interaction.reply({ content: err.message, components: [retryRow()], flags: EPH });
    }
    data.ign = data.raw.ign;
    data.uuid = null;
    data.bin = budget.max;
    // A best offer only exists once a seller actually offers something.
    data.co = 'Offer';
    data.basics = {
      price_min: budget.min,
      description: data.raw.description.slice(0, 1000),
      amount: data.raw.amount.slice(0, 40),
    };
    // The channel name follows the title until the buyer changes it.
    data.channelName = tickets.sanitizeListingChannelName(data.ign);
    const kindLabel = (proxyCategories.resolve(data.category) || {}).label || data.category;
    await interaction.deferReply({ flags: EPH });
    if (!listings.wantsCapes(data.category)) {
      return interaction.editReply({
        content: `Saved. Last step: the details for **${kindLabel}**.`,
        components: [detailsRow()],
      });
    }
    return interaction.editReply(capeStepPayload(data));
  }

  if (action === 'capes') {
    if (!data) return expired(interaction);
    const page = parseInt(parts[2], 10) || 0;
    data.capes = capes.mergePageSelection(data.capes, page, interaction.values);
    return interaction.update(capeStepPayload(data));
  }

  if (action === 'cont') {
    if (!data || !data.ign) return expired(interaction);
    return interaction.showModal(listings.buildInfoModal('pw:info', data.info || {}, data.category));
  }

  if (action === 'info') {
    if (!data) return expired(interaction);
    // The detail fields plus everything the basics modal already collected.
    data.info = { ...(data.basics || {}) };
    for (const field of listings.infoFieldsForCategory(data.category)) {
      const value = interaction.fields.getTextInputValue(field.key).trim();
      // A bare number in the name-changes field reads better as "12nc".
      data.info[field.key] = field.key === 'namechanges' ? listings.formatNameChanges(value) : value;
    }
    return interaction.reply(extraStepPayload(data));
  }

  // Any field from the registry can be added, whatever the kind is.
  if (action === 'more') {
    if (!data || !data.info) return expired(interaction);
    data.moreKeys = interaction.values;
    return interaction.showModal(listings.buildPickedFieldsModal('pw:morem', data.moreKeys, data.info));
  }

  if (action === 'morem') {
    if (!data || !data.info || !data.moreKeys) return expired(interaction);
    for (const key of data.moreKeys) {
      const field = listings.FIELDS[key];
      if (!field) continue;
      const value = interaction.fields.getTextInputValue(key).trim();
      data.info[key] = key === 'namechanges' ? listings.formatNameChanges(value) : value;
    }
    data.moreKeys = null;
    return interaction.reply(extraStepPayload(data, 'Added. Anything else, or post it?'));
  }

  if (action === 'chan') {
    if (!data || !data.info) return expired(interaction);
    return interaction.showModal(listings.buildChannelNameModal('pw:chanm', data.channelName));
  }

  if (action === 'chanm') {
    if (!data || !data.info) return expired(interaction);
    const name = tickets.sanitizeListingChannelName(interaction.fields.getTextInputValue('chname'));
    if (!name) {
      return interaction.reply(extraStepPayload(data, 'That channel name has no usable characters, so I kept the old one.'));
    }
    data.channelName = name;
    return interaction.reply(extraStepPayload(data, 'Channel name updated.'));
  }

  if (action === 'post') {
    if (!data || !data.info) return expired(interaction);
    await interaction.deferReply({ flags: EPH });
    // A wizard started from `/request attach` or an import is already bound to
    // its ticket; a fresh one may join a ticket the user already has open.
    if (data.boundTicketChannelId) return finishProxy(interaction, data);
    const open = db.openTicketsForUser(interaction.user.id);
    if (!open.length) return finishProxy(interaction, data);
    return interaction.editReply({
      content: `Where should the request for **${data.ign}** go?`,
      components: [tickets.ticketPickerRow('pw:where', interaction.guild, open)],
    });
  }

  if (action === 'where') {
    if (!data || !data.info) return expired(interaction);
    await interaction.deferUpdate();
    const choice = interaction.values[0];
    if (choice !== 'new') {
      const ticket = db.getTicket(parseInt(choice, 10));
      if (!ticket || ticket.status !== 'open' || String(ticket.creator_id) !== interaction.user.id) {
        return interaction.editReply({
          content: 'That ticket is not available anymore. Start again and pick another one.',
          components: [],
        });
      }
      data.boundTicketChannelId = ticket.channel_id;
      data.boundTicketId = ticket.id;
    }
    return finishProxy(interaction, data);
  }

  if (action === 'cancel') {
    state.clear(interaction.user.id);
    return interaction.update({ content: 'Cancelled.', components: [] }).catch(() => {});
  }
}

module.exports = { handle, startWizard };
