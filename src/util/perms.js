const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { OWNER_ID, STAFF_ROLE_ID } = require('../config');

function isAdmin(member) {
  return Boolean(member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator));
}

async function requireAdmin(interaction) {
  if (isAdmin(interaction.member)) return true;
  const payload = {
    content: 'You need Administrator permissions on this server to do this.',
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (err) {
    // interaction may already be gone, nothing to do
  }
  return false;
}

function isStaffOrHigher(member, guild) {
  if (!member || !guild) return false;
  if (isAdmin(member)) return true;
  if (member.id === guild.ownerId || (OWNER_ID && member.id === OWNER_ID)) return true;
  const staffRole = guild.roles.cache.get(STAFF_ROLE_ID);
  if (!staffRole) return false;
  return member.roles.cache.some((role) => role.position >= staffRole.position);
}

function isOwner(member, guild) {
  return Boolean(member && guild && (member.id === guild.ownerId || (OWNER_ID && member.id === OWNER_ID)));
}

async function requireOwner(interaction) {
  if (isOwner(interaction.member, interaction.guild)) return true;
  const payload = {
    content: 'Only the server owner or configured bot owner can do this.',
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (err) {
    // interaction may already be gone, nothing else can be sent
  }
  return false;
}

async function requireStaffOrHigher(interaction) {
  if (isStaffOrHigher(interaction.member, interaction.guild)) return true;
  const payload = {
    content: 'You need the configured staff role (or a higher role) to manage proxies or take over TicketsBot tickets.',
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (err) {
    // interaction may already be gone, nothing else can be sent
  }
  return false;
}

module.exports = { isAdmin, requireAdmin, isOwner, requireOwner, isStaffOrHigher, requireStaffOrHigher };
