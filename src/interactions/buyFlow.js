const {
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
  ButtonBuilder, ButtonStyle,
} = require('discord.js');
const db = require('../db');
const config = require('../config');
const tickets = require('../services/tickets');
const listings = require('../services/listings');
const setup = require('../services/setup');
const sync = require('../services/sync');
const { isStaffOrHigher } = require('../util/perms');

const EPH = MessageFlags.Ephemeral;

function getParsedListing(id) {
  return db.parseListing(db.getListing(parseInt(id, 10)));
}

async function unavailable(interaction) {
  return interaction
    .reply({ content: 'This request is not open anymore.', flags: EPH })
    .catch(() => {});
}

function existingTicketReply(interaction, ticket) {
  return interaction.reply({
    content: `You already have an open ticket for this request: <#${ticket.channel_id}>`,
    flags: EPH,
  });
}

// The account a seller is offering rides along in the ticket text. It is not a
// column on ticket_items: only the price drives the request's best-offer value.
function offeredAccountLine(account) {
  return account ? `Account offered: **${account}**` : 'Account offered: _not specified_';
}

// Resolves the ticket the user picked in a `...where` menu, or null for "new".
// Returns { error } when the choice went stale between menu and click.
async function resolveTarget(interaction, choice) {
  if (choice === 'new') return { ticket: null, channel: null };
  const ticket = db.getTicket(parseInt(choice, 10));
  if (!ticket || ticket.status !== 'open' || String(ticket.creator_id) !== interaction.user.id) {
    return { error: 'That ticket is not available anymore. Try again and pick another one.' };
  }
  const channel = await interaction.client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { error: 'That ticket channel no longer exists.' };
  return { ticket, channel };
}

// Adds the card for a request/offer that is joining a ticket which is already
// open for something else, so the channel says what was just added.
async function announceAddedItem(channel, title, lines, extraRows = []) {
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(config.EMBED_COLOR)
      .setTitle(title)
      .setDescription(lines.join('\n'))],
    components: extraRows,
  }).catch(() => {});
}

async function createBuyTicket(interaction, listing, type, title, lines, { offerAmount = null, offerStatus = null, extraRows = [] } = {}) {
  const { channel, ticket, item } = await tickets.createTicketChannel(interaction.guild, {
    baseName: `${listing.ign_hidden && listing.category === 'minecon'
      ? listings.mineconChannelName(listing)
      : listings.displayIgn(listing)}-${type}`,
    categoryKey: tickets.categoryKeyForType(type),
    type,
    creatorId: interaction.user.id,
    listingId: listing.id,
    offerAmount,
    offerStatus,
  });
  const embed = new EmbedBuilder()
    .setColor(config.EMBED_COLOR)
    .setTitle(title)
    .setDescription(lines.join('\n'));
  await channel.send({
    embeds: [embed],
    components: [tickets.closeButtonRow(), ...extraRows],
  });
  const ping = await channel.send({ content: `<@${interaction.user.id}>` });
  require('../services/autodelete').registerPingDelete(ping, interaction.user.id);
  return { channel, ticket, item };
}

// `oaccept`/`odecline` carry a ticket_items id. The older `offeraccept`/
// `offerdecline` buttons still in channel history carry a ticket id instead and
// are resolved back to that ticket's pending offer.
function offerReviewRow(listingId, itemId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ls:oaccept:${listingId}:${itemId}`).setLabel('Accept Offer').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ls:odecline:${listingId}:${itemId}`).setLabel('Decline Offer').setStyle(ButtonStyle.Danger)
  );
}

function offerReviewEmbed(listing, ticket, reviewedById = null) {
  const accepted = ticket.offer_status === 'accepted';
  const declined = ticket.offer_status === 'declined';
  const state = accepted ? 'Accepted' : declined ? 'Declined' : 'Waiting for staff approval';
  const embed = new EmbedBuilder()
    .setColor(accepted ? 0x57f287 : declined ? 0xed4245 : config.EMBED_COLOR)
    .setTitle('Seller Offer Review')
    .setDescription(
      `Request: <#${listing.listing_channel_id}>\n` +
      `Asking price: **${listings.displayUsdPrice(ticket.offer_amount)}**\n` +
      `Seller: <@${ticket.creator_id}>\n` +
      `Status: **${state}**${reviewedById ? `\nReviewed by: <@${reviewedById}>` : ''}`
    );
  // While still pending, warn staff if the seller wants more than the budget.
  if (ticket.offer_status === 'pending') {
    const budget = listings.usdToNumber(listing.bin);
    const offerValue = listings.usdToNumber(ticket.offer_amount);
    if (budget !== null && offerValue !== null && offerValue > budget) {
      embed.addFields({
        name: '⚠️ Above the buyer\'s budget',
        value: `This asking price (**${listings.displayUsdPrice(ticket.offer_amount)}**) is higher than the stated budget (**${listings.displayUsdPrice(listing.bin)}**). Only accept it if the buyer agreed to pay more.`,
        inline: false,
      });
    }
  }
  return embed;
}

async function notifyOwnerOfAcceptedOffer(interaction, listing, amount) {
  try {
    const owner = await interaction.client.users.fetch(listing.requester_id);
    const listingLink = `https://discord.com/channels/${interaction.guildId}/${listing.listing_channel_id}`;
    await owner.send(
      `A seller offer of **${amount}** was accepted on your request **${listings.displayIgn(listing)}**\n${listingLink}`
    );
    return true;
  } catch (err) {
    return false;
  }
}

// Both placers run after the interaction was deferred ephemerally, and finish by
// editing that same ephemeral message. `choice` is 'new' or a ticket id.
async function placeOffer(interaction, listing, amount, choice, account = null) {
  const target = await resolveTarget(interaction, choice);
  if (target.error) return interaction.editReply({ content: target.error, components: [] });
  const lines = [
    `Request: <#${listing.listing_channel_id}>`,
    offeredAccountLine(account),
    `Asking price: **${amount}**`,
    `Seller: <@${interaction.user.id}>`,
  ];
  const title = `New offer on ${listings.displayIgn(listing)}`;
  // Exactly one "Offer another account" control per ticket: the reviewed offer
  // card grows it once staff answer. Nothing else repeats it.
  let channel = target.channel;
  let item;
  if (target.ticket) {
    item = db.addTicketItem({
      ticketId: target.ticket.id, kind: 'offer', listingId: listing.id,
      offerAmount: amount, offerStatus: 'pending',
    });
    await announceAddedItem(channel, title, lines);
  } else {
    const created = await createBuyTicket(interaction, listing, 'offer', title, lines, {
      offerAmount: amount, offerStatus: 'pending',
    });
    channel = created.channel;
    item = created.item;
  }
  await channel.send({
    content: config.STAFF_ROLE_ID ? `<@&${config.STAFF_ROLE_ID}>` : '',
    embeds: [offerReviewEmbed(listing, item)],
    components: [offerReviewRow(listing.id, item.item_id)],
    allowedMentions: config.STAFF_ROLE_ID ? { roles: [config.STAFF_ROLE_ID] } : { parse: [] },
  });
  const budget = listings.usdToNumber(listing.bin);
  const offerValue = listings.usdToNumber(amount);
  const belowNote = budget !== null && offerValue !== null && offerValue > budget
    ? ` Heads up: this is above the **${listings.displayUsdPrice(listing.bin)}** the buyer pays, so staff may hold it.`
    : '';
  return interaction.editReply({
    content: `Your offer is waiting for staff approval: <#${channel.id}>.${belowNote}`,
    components: [],
  });
}

async function handle(interaction, parts) {
  const action = parts[1];
  const listing = getParsedListing(parts[2]);
  // Cancelling a sold confirmation must work even if the listing changed state
  // in the meantime (e.g. someone else confirmed it first).
  if (action === 'soldno') {
    return interaction.update({ content: 'Cancelled - the listing is unchanged.', components: [] }).catch(() => {});
  }
  if (!listing || listing.status !== 'published') return unavailable(interaction);

  // Marking a request fulfilled pulls it off the board, so it asks first
  // instead of firing on a single click.
  if (action === 'sold') {
    if (interaction.user.id !== listing.requester_id && !isStaffOrHigher(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'Only the buyer who posted this request or staff can mark it fulfilled.', flags: EPH });
    }
    return interaction.reply({
      content: `Mark **${listings.displayIgn(listing)}** as fulfilled?\nIt moves to the fulfilled category and loses its offer buttons.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ls:soldyes:${listing.id}`).setLabel('Yes, it is fulfilled').setStyle(ButtonStyle.Danger).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`ls:soldno:${listing.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        ),
      ],
      flags: EPH,
    });
  }

  if (action === 'soldyes') {
    if (interaction.user.id !== listing.requester_id && !isStaffOrHigher(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'Only the buyer who posted this request or staff can mark it fulfilled.', flags: EPH });
    }
    await interaction.update({ content: 'Marking it fulfilled...', components: [] }).catch(() => {});
    const updated = db.updateListing(listing.id, { status: 'sold' });
    await setup.organizeListing(interaction.guild, updated);
    await listings.renderPublished(interaction.client, updated);
    sync.emitListingUpdate(updated);
    require('../services/logs').listing(interaction.client, 'fulfilled', listing, interaction.user.id, [
      { name: 'Budget', value: listings.displayUsdPrice(listing.bin), inline: true },
      { name: 'Best offer', value: listings.displayUsdPrice(listing.co), inline: true },
    ]);
    // Refresh the ticket card (it drops its Mark Sold control) and clear any
    // older messages that still carry one.
    await listings.renderPreview(interaction.client, updated).catch(() => {});
    await listings.stripSoldButtons(interaction.client, updated).catch(() => {});

    // The buyer is pinged first, then staff.
    const mentionParts = [];
    const users = [];
    const roles = [];
    if (listing.requester_id) {
      mentionParts.push(`<@${listing.requester_id}>`);
      users.push(listing.requester_id);
    }
    if (config.STAFF_ROLE_ID) {
      mentionParts.push(`<@&${config.STAFF_ROLE_ID}>`);
      roles.push(config.STAFF_ROLE_ID);
    } else if (config.OWNER_ID) {
      mentionParts.push(`<@${config.OWNER_ID}>`);
      users.push(config.OWNER_ID);
    }
    const ticketChannel = listing.ticket_channel_id
      ? await interaction.client.channels.fetch(listing.ticket_channel_id).catch(() => null)
      : null;
    const noticeChannel = ticketChannel || interaction.channel;
    const where = listing.listing_channel_id ? ` (<#${listing.listing_channel_id}>)` : '';
    await noticeChannel.send({
      content: `${mentionParts.join(' ')} the request **${listings.displayIgn(listing)}**${where} was marked fulfilled by <@${interaction.user.id}>.`,
      allowedMentions: { users, roles },
    }).catch(() => {});
    return interaction.editReply({
      content: `**${listings.displayIgn(listing)}** is marked fulfilled and staff were notified.`,
      components: [],
    }).catch(() => {});
  }

  if (action === 'offer') {
    const existing = db.findOpenTicketItem('offer', listing.id, interaction.user.id);
    if (existing && existing.offer_status !== 'declined') return existingTicketReply(interaction, existing);
    const modal = new ModalBuilder()
      .setCustomId(`ls:offerm:${listing.id}`)
      .setTitle(`Offer on ${listings.displayIgn(listing)}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('account')
            .setLabel('Account you are offering (IGN)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80)
            .setPlaceholder('The account that matches this request')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('Your asking price')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(64)
            .setPlaceholder('USD only, e.g. 50 or $50')
        )
      );
    return interaction.showModal(modal);
  }

  if (action === 'offerm') {
    let amount;
    let account;
    try {
      account = interaction.fields.getTextInputValue('account').trim().slice(0, 80);
      amount = listings.normalizeUsdPrice(interaction.fields.getTextInputValue('amount'));
      if (amount === 'Offer') throw new Error('Enter a positive USD asking price.');
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    const existing = db.findOpenTicketItem('offer', listing.id, interaction.user.id);
    if (existing && existing.offer_status !== 'declined') return existingTicketReply(interaction, existing);
    await interaction.deferReply({ flags: EPH });
    // An offer can join a ticket the seller already has open, so a support or
    // request ticket can carry it instead of spawning another channel.
    const open = db.openTicketsForUser(interaction.user.id);
    if (!open.length) return placeOffer(interaction, listing, amount, 'new', account);
    // Only the amount rides in the custom id (it is re-validated there); the
    // account name is kept in the ticket text of the message written below.
    db.setSetting(`offer_account_${listing.id}_${interaction.user.id}`, account);
    return interaction.editReply({
      content: `Where should your offer of **${amount}** on **${listings.displayIgn(listing)}** go?`,
      components: [tickets.ticketPickerRow(`ls:offerwhere:${listing.id}:${amount}`, interaction.guild, open)],
    });
  }

  // "Offer another account" from inside a ticket: no picker, the offer lands in
  // the ticket the button was pressed in.
  if (action === 'again' || action === 'againm') {
    const ticket = db.getTicketByChannel(interaction.channelId);
    if (!ticket) {
      return interaction.reply({ content: 'Use this inside an open ticket channel.', flags: EPH });
    }
    if (String(ticket.creator_id) !== interaction.user.id) {
      return interaction.reply({
        content: 'Only the seller this ticket belongs to can offer here. Staff can use `/offer add`.',
        flags: EPH,
      });
    }
    // One offer in review at a time; a declined or accepted one may be replaced.
    const pending = db.findOpenTicketItem('offer', listing.id, interaction.user.id);
    if (pending && pending.offer_status === 'pending') {
      return interaction.reply({
        content: `Your offer of **${listings.displayUsdPrice(pending.offer_amount)}** is still waiting for staff review in <#${pending.channel_id}>.`,
        flags: EPH,
      });
    }
    if (action === 'again') {
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(`ls:againm:${listing.id}`)
          .setTitle(`Offer on ${listings.displayIgn(listing)}`.slice(0, 45))
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('account')
                .setLabel('Account you are offering (IGN)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(80)
                .setPlaceholder('The account that matches this request')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Your new asking price')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(64)
                .setPlaceholder('USD only, e.g. 50 or $50')
            )
          )
      );
    }
    let amount;
    let account;
    try {
      account = interaction.fields.getTextInputValue('account').trim().slice(0, 80);
      amount = listings.normalizeUsdPrice(interaction.fields.getTextInputValue('amount'));
      if (amount === 'Offer') throw new Error('Enter a positive USD asking price.');
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    return placeOffer(interaction, listing, amount, String(ticket.id), account);
  }

  if (action === 'offerwhere') {
    // The amount rides in the custom id, so it is re-validated before it is
    // stored or rendered rather than trusted as-is.
    let amount;
    try {
      amount = listings.normalizeUsdPrice(parts.slice(3).join(':'));
      if (amount === 'Offer') throw new Error('Enter a positive USD offer amount.');
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    await interaction.deferUpdate();
    const key = `offer_account_${listing.id}_${interaction.user.id}`;
    const account = db.getSetting(key);
    db.delSetting(key);
    return placeOffer(interaction, listing, amount, interaction.values[0], account);
  }

  if (action === 'oaccept' || action === 'odecline' || action === 'offeraccept' || action === 'offerdecline') {
    if (!isStaffOrHigher(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'Only staff can review seller offers.', flags: EPH });
    }
    const id = parseInt(parts[3], 10);
    const item = action.startsWith('offer')
      ? db.pendingOfferItemForTicket(id, listing.id)
      : db.getTicketItem(id);
    if (!item || item.kind !== 'offer' || item.listing_id !== listing.id || item.status !== 'open') {
      return interaction.reply({ content: 'This offer is no longer available.', flags: EPH });
    }
    if (item.offer_status !== 'pending' || !item.offer_amount) {
      return interaction.reply({ content: 'This offer has already been reviewed.', flags: EPH });
    }
    await interaction.deferUpdate();
    const accepted = action === 'oaccept' || action === 'offeraccept';
    const ticket = item;
    const reviewed = db.updateTicketItemOfferStatus(item.item_id, accepted ? 'accepted' : 'declined');
    if (accepted) {
      const updated = db.updateListing(listing.id, { co: ticket.offer_amount });
      await listings.renderPublished(interaction.client, updated);
      sync.emitListingUpdate(updated);
    }
    // The reviewed card swaps its Accept/Decline pair for a re-bid button, so a
    // declined or outbid buyer can go again without leaving the ticket.
    await interaction.editReply({
      embeds: [offerReviewEmbed(listing, reviewed, interaction.user.id)],
      components: [listings.buildOfferAgainRow(listing.id)],
    });
    await interaction.channel.send({
      content: `<@${ticket.creator_id}> Your offer of **${listings.displayUsdPrice(ticket.offer_amount)}** was ${accepted ? 'accepted and set as the best offer on the request' : 'declined'} by <@${interaction.user.id}>.`,
      allowedMentions: { users: [ticket.creator_id, interaction.user.id] },
    }).catch(() => {});
    if (accepted) {
      const dmOk = await notifyOwnerOfAcceptedOffer(interaction, listing, ticket.offer_amount);
      // Also tell the buyer in their own request ticket, so it is on record even
      // when their DMs are closed. Skipped when the offer itself lives in that
      // same ticket: buyer and seller must not be able to identify each other.
      if (listing.ticket_channel_id && listing.ticket_channel_id !== ticket.channel_id) {
        const ownerTicket = await interaction.client.channels.fetch(listing.ticket_channel_id).catch(() => null);
        if (ownerTicket) {
          await ownerTicket.send({
            content: `<@${listing.requester_id}>`,
            // Deliberately no buyer identity or ticket link: buyer and seller
            // must not be able to find each other and bypass the proxy fee.
            embeds: [new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle('Offer accepted')
              .setDescription(
                `A seller offer of **${listings.displayUsdPrice(ticket.offer_amount)}** on your request **${listings.displayIgn(listing)}** was accepted by <@${interaction.user.id}>.` +
                `${dmOk ? '' : '\n_(I could not DM you, so this is the only notice.)_'}`
              )],
            allowedMentions: { users: [listing.requester_id] },
          }).catch(() => {});
        }
      }
      // Announce the new C/O in the public listing channel.
      const fresh = db.getListing(listing.id);
      // Every seller asking more is told they are no longer the front runner,
      // without naming the seller who now is.
      await listings.notifyOutbid(interaction.client, fresh, ticket.offer_amount, { excludeUserId: ticket.creator_id }).catch(() => {});
    }
    return null;
  }

}

module.exports = { handle };
