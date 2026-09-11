const {
  MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, OverwriteType,
  EmbedBuilder,
} = require('discord.js');
const db = require('../db');
const config = require('../config');
const { requireStaffOrHigher } = require('../util/perms');
const listings = require('../services/listings');
const tickets = require('../services/tickets');
const capes = require('../services/capes');
const setup = require('../services/setup');
const proxyCategories = require('../services/proxyCategories');
const channelPerms = require('../services/channelPerms');

const EPH = MessageFlags.Ephemeral;
const P = PermissionFlagsBits;

function getParsedListing(id) {
  return db.parseListing(db.getListing(parseInt(id, 10)));
}

async function missing(interaction) {
  return interaction.reply({ content: 'That request no longer exists.', flags: EPH }).catch(() => {});
}

async function rerender(client, listingId) {
  const row = db.getListing(listingId);
  if (!row) return;
  await listings.renderPreview(client, row);
  await listings.renderPublished(client, row);
  require('../services/sync').emitListingUpdate(row);
}

async function sendAcceptedNotice(client, listing, staffId, listingChannelId) {
  if (!listing.ticket_channel_id) return;
  const ticketChannel = await client.channels.fetch(listing.ticket_channel_id).catch(() => null);
  if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) return;
  await ticketChannel.send({
    content: `✅ Request approved by <@${staffId}>.${listingChannelId ? ` Request channel: <#${listingChannelId}>.` : ''}`,
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

// Single source of truth for listing-channel access, shared with /channelperms.
async function listingChannelOverwrites(guild) {
  return channelPerms.overwritesFor(guild, 'listing');
}

// Editing actions the buyer may run on their own request while it is still
// unpublished. Accepting, denying, publishing and deleting stay staff-only.
const OWNER_EDITABLE = new Set(['edit', 'editsel', 'editbasics', 'editinfo', 'editprice', 'editcapes']);

async function handle(interaction, parts) {
  const action = parts[1];
  const listing = getParsedListing(parts[2]);
  if (!listing) {
    // Check existence before permissions so a stale card gives a clear reason.
    if (!(await requireStaffOrHigher(interaction))) return;
    return missing(interaction);
  }
  // The buyer may fix their own request only while it is still under review.
  // Once staff accept it, editing is staff-only.
  const isOwner = interaction.user.id === listing.requester_id;
  const ownerMayEdit = isOwner && listing.status === 'pending' && OWNER_EDITABLE.has(action);
  if (!ownerMayEdit && !(await requireStaffOrHigher(interaction))) return;

  if (action === 'accept') {
    // Imported proxies already have their public listing channel. Send the
    // single managed listing card there once staff confirm the ticket review.
    if (listing.status === 'pending' && listing.listing_channel_id) {
      await interaction.deferUpdate();
      const channel = await interaction.client.channels.fetch(listing.listing_channel_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.followUp({ content: 'The transferred request channel no longer exists.', flags: EPH }).catch(() => {});
      }
      const published = await channel.send(listings.listingPayload({ ...listing, status: 'published' }, 'published'));
      const updated = db.updateListing(listing.id, {
        status: 'published', listing_message_id: published.id,
      });
      // An imported channel keeps whatever perms it had, so normalise it now.
      await channelPerms.applyListingPerms(interaction.guild, channel);
      require('../services/sync').emitListingUpdate(updated);
      await setup.organizeListing(interaction.guild, updated);
      // Keep the stored preview card in sync as well, not just the pressed one.
      await listings.renderPreview(interaction.client, updated);
      await interaction.editReply(listings.listingPayload(db.parseListing(updated), 'ticket-published', { isEdit: true, revealIgn: true }));
      await sendAcceptedNotice(interaction.client, db.parseListing(updated), interaction.user.id, channel.id);
      return interaction.followUp({
        content: `Transferred request approved and published in <#${channel.id}>.`,
        flags: EPH,
      }).catch(() => {});
    }
    // Recovery path. A listing can end up "accepted" with a channel but no
    // published card if the Finish step never completed (rate limit, deleted
    // prompt, restart). Pressing Accept again resumes instead of dead-ending.
    if (listing.listing_channel_id) {
      // Acknowledge first: everything below is REST work.
      await interaction.deferReply({ flags: EPH });
      const existing = await interaction.client.channels.fetch(listing.listing_channel_id).catch(() => null);
      if (!existing) {
        // The channel is gone, so start the accept flow over from scratch.
        db.updateListing(listing.id, { listing_channel_id: null, listing_message_id: null, status: 'pending' });
        return interaction.editReply('The old listing channel no longer exists, so I reset this listing. Press **Accept** again to pick a new channel name.');
      }
      if (listing.listing_message_id) {
        const posted = await existing.messages.fetch(listing.listing_message_id).catch(() => null);
        if (posted) {
          return interaction.editReply(`Already published in <#${existing.id}>.`);
        }
      }
      // Channel exists but the card is missing: publish it now.
      const published = await existing.send(listings.listingPayload({ ...listing, status: 'published' }, 'published'));
      const updated = db.updateListing(listing.id, { status: 'published', listing_message_id: published.id });
      await channelPerms.applyListingPerms(interaction.guild, existing).catch(() => {});
      require('../services/sync').emitListingUpdate(updated);
      await setup.organizeListing(interaction.guild, updated).catch(() => {});
      await rerender(interaction.client, listing.id);
      await sendAcceptedNotice(interaction.client, db.parseListing(updated), interaction.user.id, existing.id);
      return interaction.editReply(`This request was stuck half-accepted, so I finished it: published in <#${existing.id}>.`);
    }
    const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
    // Stats accounts sell on their numbers. Minecon channels use year-namechanges.
    // Other account categories use the account name itself.
    // Whatever the buyer suggested, falling back to their title.
    const suggested = tickets.sanitizeListingChannelName(listing.name_suggestion || listing.ign) || 'request';
    const modal = new ModalBuilder()
      .setCustomId(`rv:chan:${listing.id}`)
      .setTitle('Request channel name')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('chname')
            .setLabel('Channel name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(90)
            .setPlaceholder(suggested)
            .setValue(suggested.slice(0, 90))
        )
      );
    // Offer the notification ping only when this category actually has a ping
    // role set up. Modals cannot hold switches, so it is a yes/no field.
    const pingRole = db.getPingRoleByRef(`cat:${listing.category}`);
    if (pingRole) {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pingrole')
            .setLabel(`Ping the ${pingRole.label} role? (yes/no)`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(5)
            .setPlaceholder('yes')
            .setValue('yes')
        )
      );
    }
    return interaction.showModal(modal);
  }

  if (action === 'chan') {
    await interaction.deferReply({ flags: EPH });
    const name = tickets.sanitizeListingChannelName(interaction.fields.getTextInputValue('chname'));
    // Remember the ping choice until the listing is actually published (Finish).
    let pingChoice = '';
    try {
      pingChoice = interaction.fields.getTextInputValue('pingrole');
    } catch (err) {
      pingChoice = '';
    }
    if (listings.parseYesNo(pingChoice, false)) db.setSetting(`ping_on_publish_${listing.id}`, '1');
    else db.delSetting(`ping_on_publish_${listing.id}`);
    const guild = interaction.guild;
    const baseParent = await setup.ensureListingCategory(guild, listing.category).catch(() => null);
    // Roll over to "<Category> 2" when the category has hit Discord's 50 limit.
    const parent = baseParent ? await tickets.categoryWithSpace(guild, baseParent).catch(() => baseParent) : null;
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parent ? parent.id : undefined,
      permissionOverwrites: await listingChannelOverwrites(guild),
    });
    // No "write your content, then press Finish" step: the card goes up with
    // the channel, and staff can still edit it from the ticket afterwards.
    const published = await channel.send(listings.listingPayload({ ...listing, status: 'published' }, 'published'));
    const updated = db.updateListing(listing.id, {
      status: 'published', listing_channel_id: channel.id, listing_message_id: published.id,
    });
    await setup.organizeListing(guild, updated);
    await listings.renderPreview(interaction.client, updated);
    require('../services/sync').emitListingUpdate(updated);
    await sendAcceptedNotice(interaction.client, db.parseListing(updated), interaction.user.id, channel.id);
    if (db.getSetting(`ping_on_publish_${listing.id}`)) {
      const pingRole = db.getPingRoleByRef(`cat:${listing.category}`);
      if (pingRole) {
        await channel.send({
          content: `<@&${pingRole.role_id}>`,
          allowedMentions: { roles: [pingRole.role_id] },
        }).catch(() => {});
      }
      db.delSetting(`ping_on_publish_${listing.id}`);
    }
    return interaction.editReply({
      content: `Request published in <#${channel.id}>.`,
    });
  }

  if (action === 'finish') {
    if (!listing.listing_channel_id) return missing(interaction);
    if (listing.listing_message_id) {
      // Only treat it as published if the card is actually still there.
      const channel = await interaction.client.channels.fetch(listing.listing_channel_id).catch(() => null);
      const posted = channel ? await channel.messages.fetch(listing.listing_message_id).catch(() => null) : null;
      if (posted) {
        return interaction.reply({ content: 'This request is already published.', flags: EPH });
      }
      db.updateListing(listing.id, { listing_message_id: null });
    }
    await interaction.deferUpdate();
    const channel = await interaction.client.channels.fetch(listing.listing_channel_id).catch(() => null);
    if (!channel) {
      return interaction.followUp({ content: 'The request channel no longer exists.', flags: EPH }).catch(() => {});
    }
    const published = await channel.send(listings.listingPayload({ ...listing, status: 'published' }, 'published'));
    db.updateListing(listing.id, { status: 'published', listing_message_id: published.id });
    // Notify the category's ping role if that was chosen when accepting.
    if (db.getSetting(`ping_on_publish_${listing.id}`)) {
      const pingRole = db.getPingRoleByRef(`cat:${listing.category}`);
      if (pingRole) {
        await channel.send({
          content: `<@&${pingRole.role_id}>`,
          allowedMentions: { roles: [pingRole.role_id] },
        }).catch(() => {});
      }
      db.delSetting(`ping_on_publish_${listing.id}`);
    }
    await interaction.message.delete().catch((err) => console.error('Could not delete the Finish prompt:', err.message));
    // The Finish prompt was the deferred interaction response and was deleted
    // above, so a follow-up is required instead of editing an unknown message.
    await interaction.followUp({ content: 'Request published. ✅', flags: EPH }).catch(() => {});
    // No follow-up message: the ticket card itself already carries Mark Sold.
    await rerender(interaction.client, listing.id);
    return null;
  }

  if (action === 'deny') {
    db.updateListing(listing.id, { status: 'denied' });
    await interaction.reply({ content: 'Request denied.', flags: EPH });
    await rerender(interaction.client, listing.id);
    const ticketChannel = await interaction.client.channels.fetch(listing.ticket_channel_id).catch(() => null);
    if (ticketChannel) {
      await ticketChannel.send({
        content: `<@${listing.requester_id}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`Your request for **${listings.displayIgn(listing)}** was denied by <@${interaction.user.id}>.`),
        ],
        components: [tickets.closeButtonRow()],
        allowedMentions: { users: [listing.requester_id] },
      });
    }
    return null;
  }

  if (action === 'edit') {
    return interaction.reply({
      content: `Editing the request **${listings.displayIgn(listing)}**. What do you want to change?`,
      components: [listings.buildEditSelectRow(listing.id)],
      flags: EPH,
    });
  }

  if (action === 'editsel') {
    const choice = interaction.values[0];
    if (choice === 'basics') {
      return interaction.showModal(listings.buildBasicsModal(`rv:editbasics:${listing.id}`, {
        kind: (proxyCategories.resolve(listing.category) || {}).label || listing.category,
        ign: listing.ign,
        description: listing.info.description,
        budget: listings.budgetInputValue(listing),
        amount: listing.info.amount,
      }));
    }
    if (choice === 'info') return interaction.showModal(listings.buildInfoModal(`rv:editinfo:${listing.id}`, listing.info, listing.category));
    if (choice === 'prices') return interaction.showModal(listings.buildPriceModal(`rv:editprice:${listing.id}`, listing));
    if (choice === 'capes') {
      return interaction.reply({
        content: 'Pick the new cape set:',
        components: listings.buildCapeSelectRows(`rv:editcapes:${listing.id}`, listing.capes),
        flags: EPH,
      });
    }
    return null;
  }

  if (action === 'editbasics') {
    const ign = interaction.fields.getTextInputValue('ign').trim();
    if (!ign) return interaction.reply({ content: 'The title cannot be empty.', flags: EPH });
    let budget;
    try {
      budget = listings.normalizeUsdPrice(interaction.fields.getTextInputValue('budget'));
    } catch (err) {
      return interaction.reply({ content: err.message, flags: EPH });
    }
    const typedKind = interaction.fields.getTextInputValue('kind').trim();
    const category = proxyCategories.resolve(typedKind);
    await interaction.deferReply({ flags: EPH });
    const info = {
      ...listing.info,
      description: listings.cleanFieldValue('description', interaction.fields.getTextInputValue('description')).slice(0, 1000),
      amount: listings.cleanFieldValue('amount', interaction.fields.getTextInputValue('amount')).slice(0, 40),
    };
    db.updateListing(listing.id, {
      ign, bin: budget, info, ...(category ? { category: category.key } : {}),
    });
    if (category && category.key !== listing.category) {
      await setup.organizeListing(interaction.guild, db.getListing(listing.id)).catch(() => {});
    }
    await rerender(interaction.client, listing.id);
    return interaction.editReply({
      content: `Request updated.${category ? '' : `\nI have no **${typedKind}** section, so the kind stayed **${(proxyCategories.resolve(listing.category) || {}).label || listing.category}**.`}`,
    });
  }

  if (action === 'editinfo') {
    await interaction.deferReply({ flags: EPH });
    // Keep the basics (description, amount) that this modal does not
    // show, so editing the requirements never wipes them.
    const info = { ...listing.info };
    for (const field of listings.infoFieldsForCategory(listing.category)) {
      info[field.key] = listings.cleanFieldValue(field.key, interaction.fields.getTextInputValue(field.key));
    }
    db.updateListing(listing.id, { info });
    await rerender(interaction.client, listing.id);
    return interaction.editReply({ content: 'Requirements updated.' });
  }

  if (action === 'editprice') {
    await interaction.deferReply({ flags: EPH });
    let co;
    try {
      co = listings.normalizeUsdPrice(interaction.fields.getTextInputValue('co'));
    } catch (err) {
      return interaction.editReply(err.message);
    }
    db.updateListing(listing.id, { co });
    await rerender(interaction.client, listing.id);
    return interaction.editReply({ content: 'Best offer updated.' });
  }

  if (action === 'editcapes') {
    const page = parseInt(parts[3], 10) || 0;
    const newCapes = capes.mergePageSelection(listing.capes, page, interaction.values);
    await interaction.deferUpdate();
    db.updateListing(listing.id, { capes: newCapes });
    await rerender(interaction.client, listing.id);
    return interaction.editReply({
      content: 'Capes updated.',
      components: listings.buildCapeSelectRows(`rv:editcapes:${listing.id}`, newCapes),
    });
  }

  if (action === 'delyes') {
    await interaction.deferUpdate();
    // Take it off the Angels API first: that API validates the channel, so the
    // call would fail once the Discord channel is gone.
    if (listing.listing_channel_id) {
      await require('../services/angels').removeListing(listing.listing_channel_id).catch(() => {});
      const channel = await interaction.client.channels.fetch(listing.listing_channel_id).catch(() => null);
      if (channel) await channel.delete('Request deleted').catch(() => {});
    }
    db.updateListing(listing.id, { status: 'deleted' });
    await setup.refreshListingCategoryVisibility(interaction.guild);
    // `local` keeps the deletion here: linked servers are not told, so their
    // own copy of the listing stays up.
    const localOnly = parts[3] === 'local';
    if (localOnly) {
      await listings.renderPreview(interaction.client, db.getListing(listing.id)).catch(() => {});
    } else {
      await rerender(interaction.client, listing.id);
    }
    return interaction.editReply({
      content: `Request **${listings.displayIgn(listing)}** deleted${localOnly ? ' on this server only.' : '.'}`,
      components: [],
    });
  }

  if (action === 'delno') {
    return interaction.update({ content: 'Deletion cancelled.', components: [] });
  }
}

module.exports = { handle };
