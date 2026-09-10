const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const state = require('../util/state');
const db = require('../db');
const config = require('../config');
const mojang = require('../services/mojang');
const blabit = require('../services/blabit');
const capes = require('../services/capes');
const listings = require('../services/listings');
const tickets = require('../services/tickets');
const proxyCategories = require('../services/proxyCategories');
const setup = require('../services/setup');
const sync = require('../services/sync');
const logs = require('../services/logs');

const EPH = MessageFlags.Ephemeral;

async function startWizard(interaction, options = {}) {
  state.set(interaction.user.id, {
    step: 'category',
    ownerId: options.ownerId || interaction.user.id,
    ignHidden: Boolean(options.ignHidden),
    suppressProxyNotice: Boolean(options.suppressProxyNotice),
    hideProxyLabel: Boolean(options.hideProxyLabel),
    // Set when importing an existing (third-party) ticket: the listing is bound
    // to that channel instead of a freshly created one.
    boundTicketChannelId: options.boundTicketChannelId || null,
    boundTicketId: options.boundTicketId || null,
    // Optional existing public listing channel to reuse instead of creating one.
    boundListingChannelId: options.boundListingChannelId || null,
  });
  await interaction.reply({
    content: 'Let us post what you are looking for. First, pick the account category.',
    components: [listings.buildCategorySelectRow('pw:cat', setup.proxyCategoriesInDiscordOrder(interaction.guild))],
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
  const shownIgn = data.ignHidden ? 'Hidden' : data.ign;
  const heading = data.uuid
    ? (data.detected && data.detected.length
      ? `Capes found on **${shownIgn}**:`
      : `No capes found on **${shownIgn}**.`)
    : `Which capes should **${shownIgn}** have?`;
  const warning = data.uuid
    ? ''
    : '\n_This request does not name an existing account, so nothing was auto-detected._';
  const templateNote = data.template
    ? (data.templateApplied
      ? '\n\n📋 Template from a linked server applied (capes, details and budget prefilled).'
      : '\n\n📋 A linked server already knows this account. Press **Use template** to prefill its capes, details and prices.')
    : '';
  const instructions = '\n\nPick the capes you want the account to have (leave empty if you do not care), then press Continue.';
  const fixed = `${heading}\n${warning}${templateNote}${instructions}`;
  return {
    content: `${heading}\n${fitCapeLine(line, 1990 - fixed.length)}${warning}${templateNote}${instructions}`,
    components: [
      ...listings.buildCapeSelectRows('pw:capes', data.capes),
      new ActionRowBuilder().addComponents(
        ...[
          new ButtonBuilder().setCustomId('pw:cont').setLabel('Continue').setStyle(ButtonStyle.Primary),
          ...(data.template && !data.templateApplied
            ? [new ButtonBuilder().setCustomId('pw:tpl').setLabel('Use template').setStyle(ButtonStyle.Success).setEmoji('📋')]
            : []),
          new ButtonBuilder().setCustomId('pw:hide')
            .setLabel(data.ignHidden ? 'Title: Hidden' : 'Hide title')
            .setStyle(data.ignHidden ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji(data.ignHidden ? '🙈' : '👁️'),
          new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ],
      ),
    ],
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
    nameSuggestion: data.prefill ? data.prefill.nameSuggestion : null,
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
      const label = data.ignHidden
        ? (data.category === 'minecon' ? listings.mineconChannelName(db.parseListing(listing)) : 'hidden')
        : data.ign;
      const wanted = tickets.sanitizeChannelName(`${label}-request-${ticket.number}`);
      if (channel.name !== wanted) {
        await channel.setName(wanted, 'Imported request ticket named after what it looks for').catch((err) => {
          console.error('Could not rename imported request ticket:', err.message);
        });
      }
    }
  } else {
    ({ channel, ticket } = await tickets.createTicketChannel(guild, {
      baseName: `${data.ignHidden
        ? `${data.category === 'minecon' ? listings.mineconChannelName(db.parseListing(listing)) : 'hidden'}-request`
        : `${data.ign}-request`}`,
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
    data.category = interaction.values[0];
    if (!proxyCategories.resolve(data.category)) return expired(interaction);
    return interaction.showModal(listings.buildIgnModal('pw:ign', { ignHidden: data.ignHidden }));
  }

  if (action === 'ignretry') {
    if (!data) return expired(interaction);
    return interaction.showModal(listings.buildIgnModal('pw:ign', { ignHidden: data.ignHidden }));
  }

  if (action === 'ign') {
    if (!data) return expired(interaction);
    const ign = interaction.fields.getTextInputValue('ign').trim();
    // The hide choice is entered in the same modal as the username.
    let hiddenChoice = '';
    try {
      hiddenChoice = interaction.fields.getTextInputValue('hidden');
    } catch (err) {
      hiddenChoice = '';
    }
    data.ignHidden = listings.parseYesNo(hiddenChoice, Boolean(data.ignHidden));
    const retryRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pw:ignretry').setLabel('Enter it again').setStyle(ButtonStyle.Primary).setEmoji('📝'),
      new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    if (!ign) {
      return interaction.reply({
        content: 'Write what you are looking for, for example `3-letter OG name` or the exact IGN of the account you want.',
        components: [retryRow],
        flags: EPH,
      });
    }
    await interaction.deferReply({ flags: EPH });
    data.ign = ign;
    data.uuid = null;
    // A request may name one exact account or describe a whole class of them.
    // Only the first kind can be resolved on Mojang, and a failed lookup is
    // never fatal here: the request is about an account the buyer does not own.
    if (mojang.isValidIgn(ign)) {
      try {
        const resolved = await mojang.resolveUser(ign);
        if (resolved) {
          data.uuid = resolved.uuid;
          data.ign = resolved.name;
        }
      } catch (err) {
        console.error('Mojang lookup failed:', err.message);
      }
    }
    let capeUrl = null;
    if (data.uuid) {
      const textures = await mojang.getProfileTextures(data.uuid).catch(() => null);
      if (textures) capeUrl = textures.capeUrl;
    }
    data.detected = data.uuid ? await capes.detectCapes(data.uuid, capeUrl) : [];
    data.capes = [...data.detected];
    data.prefill = data.uuid && data.category === 'stat' ? await blabit.getPrefill(data.uuid) : null;
    // Offer the existing listing from a linked server as a starting point.
    data.template = data.uuid ? sync.findTemplate(data.uuid) : null;
    data.templateApplied = false;
    return interaction.editReply(capeStepPayload(data));
  }

  if (action === 'tpl') {
    if (!data || !data.template) return expired(interaction);
    const template = data.template.data || {};
    if (Array.isArray(template.capes) && template.capes.length) data.capes = [...template.capes];
    if (template.info && typeof template.info === 'object') data.info = { ...template.info };
    if (template.co) data.co = template.co;
    if (template.bin) data.bin = template.bin;
    if (template.ign_hidden) data.ignHidden = true;
    if (template.name_suggestion && !data.prefill) data.prefill = { nameSuggestion: template.name_suggestion };
    data.templateApplied = true;
    return interaction.update(capeStepPayload(data));
  }

  if (action === 'capes') {
    if (!data) return expired(interaction);
    const page = parseInt(parts[2], 10) || 0;
    data.capes = capes.mergePageSelection(data.capes, page, interaction.values);
    return interaction.update(capeStepPayload(data));
  }

  if (action === 'hide') {
    if (!data) return expired(interaction);
    data.ignHidden = !data.ignHidden;
    return interaction.update(capeStepPayload(data));
  }

  if (action === 'cont') {
    if (!data || !data.ign) return expired(interaction);
    if (data.category === 'minecon' && !listings.mineconYear({ capes: data.capes })) {
      return interaction.reply({
        content: 'Select the Minecon cape you are after so I can derive the year for its channel name.',
        flags: EPH,
      });
    }
    const prefillValues = data.info || {
      ranks: data.prefill ? data.prefill.ranksNwl : '',
      stats: data.prefill ? data.prefill.stats : '',
    };
    return interaction.showModal(listings.buildInfoModal('pw:info', prefillValues, data.category));
  }

  if (action === 'info') {
    if (!data) return expired(interaction);
    data.info = {};
    for (const field of listings.infoFieldsForCategory(data.category)) {
      const value = interaction.fields.getTextInputValue(field.key).trim();
      // A bare number in the name-changes field reads better as "12nc".
      data.info[field.key] = field.key === 'namechanges' ? listings.formatNameChanges(value) : value;
    }
    return interaction.reply({
      content: 'Requirements saved. Last step: set your budget. Leaving it blank means **Offer** (open to any price).',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('pw:price').setLabel('Set budget').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('pw:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
      flags: EPH,
    });
  }

  if (action === 'price') {
    if (!data || !data.info) return expired(interaction);
    return interaction.showModal(listings.buildPriceModal('pw:pricem', data));
  }

  if (action === 'pricem') {
    if (!data || !data.info) return expired(interaction);
    try {
      data.co = listings.normalizeUsdPrice(interaction.fields.getTextInputValue('co'));
      data.bin = listings.normalizeUsdPrice(interaction.fields.getTextInputValue('bin'));
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    // A wizard started from `/proxy attach` or an import is already bound to its
    // ticket; a fresh one may join a ticket the user already has open.
    if (data.boundTicketChannelId) return finishProxy(interaction, data);
    const open = db.openTicketsForUser(interaction.user.id);
    if (!open.length) return finishProxy(interaction, data);
    return interaction.editReply({
      content: `Where should the request for **${data.ignHidden ? 'Hidden' : data.ign}** go?`,
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
