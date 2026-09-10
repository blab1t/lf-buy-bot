const { PermissionFlagsBits, OverwriteType, ChannelType } = require('discord.js');
const db = require('../db');
const config = require('../config');
const tickets = require('./tickets');

const P = PermissionFlagsBits;

const VIEW = [P.ViewChannel, P.ReadMessageHistory];
const TALK = [P.SendMessages, P.AttachFiles, P.EmbedLinks, P.AddReactions];
const THREADS = [P.CreatePublicThreads, P.CreatePrivateThreads];

async function roleFor(guild, settingKey) {
  const id = db.getSetting(settingKey);
  return id ? guild.roles.fetch(id).catch(() => null) : null;
}

async function staffRole(guild) {
  return config.STAFF_ROLE_ID ? guild.roles.fetch(config.STAFF_ROLE_ID).catch(() => null) : null;
}

// Presets describe who can see and who can talk. Every preset starts from a
// clean slate: @everyone is denied and the bot always keeps access.
const PRESETS = {
  listing: {
    label: 'Listing (proxy default)',
    description: 'Members and Clients can see the listing and its history, but only staff can post.',
  },
  chat: {
    label: 'Chat',
    description: 'Verified Members and Clients can view and talk.',
  },
  announcement: {
    label: 'Announcement',
    description: 'Members and Clients can view and read history; only staff can post.',
  },
  staff: {
    label: 'Staff only',
    description: 'Only the staff role (and admins) can see the channel.',
  },
  locked: {
    label: 'Locked',
    description: 'Everyone who could see it keeps viewing, but nobody except staff can post.',
  },
};

async function overwritesFor(guild, preset) {
  const member = await roleFor(guild, 'member_role');
  const customer = await roleFor(guild, 'customer_role');
  const staff = await staffRole(guild);
  const list = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
    tickets.botOverwrite(guild),
  ];
  if (staff) {
    list.push({ id: staff.id, type: OverwriteType.Role, allow: [...VIEW, ...TALK, P.ManageMessages] });
  }
  const memberRoles = [member, customer].filter(Boolean);
  for (const role of memberRoles) {
    if (preset === 'staff') continue; // staff-only: members get no overwrite at all
    if (preset === 'chat') {
      list.push({ id: role.id, type: OverwriteType.Role, allow: [...VIEW, ...TALK], deny: THREADS });
    } else {
      // listing / announcement / locked all read-only for members
      list.push({ id: role.id, type: OverwriteType.Role, allow: VIEW, deny: [P.SendMessages, ...THREADS] });
    }
  }
  return list;
}

// Replaces every overwrite on the channel with the preset's set.
async function apply(guild, channel, preset) {
  if (!PRESETS[preset]) throw new Error(`Unknown preset: ${preset}`);
  if (!channel || channel.guildId !== guild.id) throw new Error('Choose a channel from this server.');
  const overwrites = await overwritesFor(guild, preset);
  await channel.permissionOverwrites.set(overwrites, `Applied ${preset} permission preset`);
  return overwrites.length;
}

// The canonical permissions for a public proxy listing channel. Used whenever a
// listing is created, accepted, imported, transferred or reorganised so its
// channel always ends up with the same access rules.
async function applyListingPerms(guild, channelOrId) {
  const channel = typeof channelOrId === 'string'
    ? await guild.channels.fetch(channelOrId).catch(() => null)
    : channelOrId;
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  try {
    await apply(guild, channel, 'listing');
    return true;
  } catch (err) {
    console.error('Could not apply listing permissions:', err.message);
    return false;
  }
}

// Makes sure a (possibly imported) ticket channel grants the bot, the staff
// role and the ticket owner access, without touching unrelated overwrites.
async function applyTicketPerms(guild, channelOrId, creatorId) {
  const channel = typeof channelOrId === 'string'
    ? await guild.channels.fetch(channelOrId).catch(() => null)
    : channelOrId;
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const memberPerms = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true };
  try {
    await channel.permissionOverwrites.edit(guild.members.me, { ...memberPerms, ManageChannels: true, ManageMessages: true, AddReactions: true });
    const staff = await staffRole(guild);
    if (staff) await channel.permissionOverwrites.edit(staff, memberPerms, { type: OverwriteType.Role });
    if (creatorId) await channel.permissionOverwrites.edit(creatorId, memberPerms, { type: OverwriteType.Member });
    return true;
  } catch (err) {
    console.error('Could not apply ticket permissions:', err.message);
    return false;
  }
}

module.exports = { PRESETS, apply, overwritesFor, applyListingPerms, applyTicketPerms };
