const { MessageFlags } = require('discord.js');
const db = require('../db');
const tickets = require('../services/tickets');
const proxyWizard = require('./proxyWizard');
const { isAdmin } = require('../util/perms');

const EPH = MessageFlags.Ephemeral;

const PANEL_TICKETS = {
  // "buy" stays the internal ticket type; on this server it is the seller side:
  // somebody offering an account to the buyers who posted requests.
  buy: {
    baseName: 'sell',
    categoryKey: 'buy',
    welcome: 'Tell us which account you are selling, its details and your price. Staff will match it against open requests.',
  },
  other: {
    baseName: 'support',
    categoryKey: 'support',
    welcome: 'Describe what you need help with. Staff will be with you shortly.',
  },
};

async function openPanelTicket(interaction, kind) {
  const def = PANEL_TICKETS[kind];
  const existing = db.findOpenTicket(kind === 'other' ? 'support' : kind, interaction.user.id, null);
  if (existing) {
    return interaction.reply({
      content: `You already have an open ticket: <#${existing.channel_id}>`,
      flags: EPH,
    });
  }
  await interaction.deferReply({ flags: EPH });
  const { channel, ticket } = await tickets.createTicketChannel(interaction.guild, {
    baseName: def.baseName,
    categoryKey: def.categoryKey,
    type: kind === 'other' ? 'support' : kind,
    creatorId: interaction.user.id,
  });
  await tickets.sendTicketWelcome(channel, ticket, def.welcome);
  return interaction.editReply({ content: `Ticket created: <#${channel.id}>` });
}

async function handle(interaction, parts) {
  const ns = parts[0];

  if (ns === 'tp') {
    const kind = parts[1];
    if (kind === 'proxy') return proxyWizard.startWizard(interaction);
    if (PANEL_TICKETS[kind]) return openPanelTicket(interaction, kind);
    return null;
  }

  if (ns === 'tk' && parts[1] === 'closebtn') {
    const ticket = db.getTicketByChannel(interaction.channelId);
    if (!ticket) {
      return interaction.reply({ content: 'This is not an open ticket channel.', flags: EPH });
    }
    if (interaction.user.id !== ticket.creator_id && !isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Only the ticket creator or staff can do that.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const result = await tickets.startClosePrompt(interaction.channel, ticket, interaction.user.id, null);
    if (result.alreadyPending) {
      return interaction.editReply({
        content: `A close request is already pending, this ticket closes <t:${Math.floor(result.closeAt / 1000)}:R> unless the creator keeps it open.`,
      });
    }
    return interaction.editReply({ content: 'Close request sent.' });
  }

  if (ns === 'cl') {
    const action = parts[1];
    const ticket = db.getTicket(parseInt(parts[2], 10));
    if (!ticket || ticket.status !== 'open') {
      return interaction.reply({ content: 'This ticket is already closed.', flags: EPH }).catch(() => {});
    }
    // `/close keep-request:true` was stored when the close was requested.
    const pending = db.getPendingClose(ticket.channel_id);
    if (action === 'force') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'Only staff can force close.', flags: EPH });
      }
      await interaction.update({ components: [] }).catch(() => {});
      return tickets.performClose(interaction.client, ticket, `force closed by ${interaction.user.tag}`, { keepListing: Boolean(pending && pending.keep_listing) });
    }
    if (interaction.user.id !== ticket.creator_id && !isAdmin(interaction.member)) {
      return interaction.reply({
        content: 'Only the ticket creator can answer this. Staff can use force close.',
        flags: EPH,
      });
    }
    if (action === 'yes') {
      await interaction.update({ components: [] }).catch(() => {});
      return tickets.performClose(interaction.client, ticket, `confirmed by ${interaction.user.tag}`, { keepListing: Boolean(pending && pending.keep_listing) });
    }
    if (action === 'no') {
      await tickets.cancelClose(interaction.channelId);
      return interaction.update({
        content: 'Okay, keeping this ticket open.',
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  }
}

module.exports = { handle };
