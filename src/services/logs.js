const { EmbedBuilder, ChannelType } = require('discord.js');
const db = require('../db');
const config = require('../config');

// Staff-facing audit log. The channel comes from /logchannel (stored in the
// database) or LOG_CHANNEL_ID in the env file. Logging never throws: a broken
// or missing log channel must not break the action being logged.
function logChannelId() {
  return db.getSetting('log_channel') || config.LOG_CHANNEL_ID || null;
}

// Separate destinations: 'audit' (default), 'messages' (edits/deletes) and
// 'transcripts'. Each falls back to nothing rather than spamming the audit log.
const CHANNEL_SETTINGS = {
  audit: 'log_channel',
  messages: 'msglog_channel',
  transcripts: 'transcript_channel',
};
function channelIdFor(kind) {
  if (kind === 'audit') return logChannelId();
  return db.getSetting(CHANNEL_SETTINGS[kind] || 'log_channel') || null;
}

// Resolving from cache avoids a REST round trip; logging must never share the
// request queue with an interaction reply, or the reply can miss Discord's
// three second acknowledgement window.
async function resolveChannel(client, channelId) {
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;
  return client.channels.fetch(channelId).catch(() => null);
}

async function send(client, { title, description, fields = [], color = config.EMBED_COLOR, actorId = null, kind = 'audit' }) {
  try {
    const channelId = channelIdFor(kind);
    if (!channelId) return false;
    const channel = await resolveChannel(client, channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return false;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title.slice(0, 256))
      .setTimestamp(new Date());
    if (description) embed.setDescription(description.slice(0, 4000));
    if (fields.length) embed.addFields(fields.slice(0, 25));
    if (actorId) embed.setFooter({ text: `by ${actorId}` });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.error('Log write failed:', err.message);
    return false;
  }
}

// Convenience wrappers for the events staff care about.
const listing = (client, action, listingRow, actor, extra = []) => send(client, {
  title: `Listing ${action}`,
  description: `**${listingRow.ign || 'Unknown'}**${actor ? ` - by <@${actor}>` : ''}`,
  fields: extra,
  color: action === 'sold' ? 0xed4245 : config.EMBED_COLOR,
});

const ticket = (client, action, description, extra = []) => send(client, {
  title: `Ticket ${action}`,
  description,
  fields: extra,
});

// Creates (or reuses) a private staff-only log channel and stores it. Only the
// bot, the staff role and admins can see it.
async function ensureLogChannel(guild, name = 'bot-logs', kind = 'audit') {
  const settingKey = CHANNEL_SETTINGS[kind] || 'log_channel';
  const existingId = db.getSetting(settingKey);
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return { channel: existing, created: false };
  }
  const byName = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === String(name).toLowerCase()
  );
  if (byName) {
    db.setSetting(settingKey, byName.id);
    return { channel: byName, created: false };
  }
  const { PermissionFlagsBits, OverwriteType } = require('discord.js');
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.members.me.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Member,
    },
  ];
  if (config.STAFF_ROLE_ID && guild.roles.cache.get(config.STAFF_ROLE_ID)) {
    overwrites.push({
      id: config.STAFF_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
      type: OverwriteType.Role,
    });
  }
  const channel = await guild.channels.create({
    name: String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 90) || 'bot-logs',
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
  });
  db.setSetting(settingKey, channel.id);
  return { channel, created: true };
}

// Message edit/delete tracking goes to its own channel.
const messageLog = (client, payload) => send(client, { ...payload, kind: 'messages' });

module.exports = { send, listing, ticket, messageLog, logChannelId, channelIdFor, ensureLogChannel, CHANNEL_SETTINGS };
