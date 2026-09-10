const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const db = require('../db');
const proxyCategories = require('./proxyCategories');
const setup = require('./setup');

const EPH = MessageFlags.Ephemeral;

const CATEGORY_EMOJI = {
  og: '👑', semi: '⭐', '3cn': '🔢', stat: '📊', cosmetics: '🎨', minecon: '🎪', other: '📦',
};

function parseEmoji(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const custom = value.match(/^<(a)?:(\w+):(\d+)>$/);
  if (custom) return { animated: Boolean(custom[1]), name: custom[2], id: custom[3] };
  return value;
}

// Returns true when the emoji was applied, false if it was invalid.
function applyEmoji(button, emoji) {
  const parsed = parseEmoji(emoji);
  if (!parsed) return false;
  try {
    button.setEmoji(parsed);
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureRole(guild, name, existingRoleId = null) {
  if (existingRoleId) {
    const byId = await guild.roles.fetch(existingRoleId).catch(() => null);
    if (byId) return byId;
  }
  const existing = guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return guild.roles.create({ name, mentionable: false, permissions: [] });
}

async function seedDefaults(guild) {
  const giveawayRole = await ensureRole(guild, 'Giveaways');
  db.upsertPingRole({ ref: 'giveaway', label: 'Giveaways', emoji: '🎉', roleId: giveawayRole.id });
  for (const category of setup.proxyCategoriesInDiscordOrder(guild)) {
    const role = await ensureRole(guild, category.label);
    db.upsertPingRole({
      ref: `cat:${category.key}`,
      label: category.label,
      emoji: CATEGORY_EMOJI[category.key] || null,
      roleId: role.id,
    });
  }
}

async function addCustom(guild, { label, emoji = null, existingRole = null }) {
  const clean = String(label || '').trim().slice(0, 80);
  if (clean.length < 2) throw new Error('Use a name with at least two characters.');
  const ref = `custom:${proxyCategories.normalizeKey(clean) || clean.toLowerCase()}`;
  if (db.getPingRoleByRef(ref)) throw new Error('A ping role with that name already exists.');
  const role = existingRole || await ensureRole(guild, clean);
  if (db.getPingRoleByRoleId(role.id)) throw new Error('That role is already a ping role.');
  return db.upsertPingRole({ ref, label: clean, emoji, roleId: role.id });
}

// Ordered to match the category channels in the sidebar: Giveaways first, then
// each proxy category in its Discord order, then any custom ping roles.
function orderedRoles(guild) {
  const rows = db.listPingRoles();
  const byRef = new Map(rows.map((row) => [row.ref, row]));
  const ordered = [];
  const used = new Set();
  const take = (ref) => {
    if (byRef.has(ref) && !used.has(ref)) {
      ordered.push(byRef.get(ref));
      used.add(ref);
    }
  };
  take('giveaway');
  for (const category of setup.proxyCategoriesInDiscordOrder(guild)) take(`cat:${category.key}`);
  for (const row of rows) if (!used.has(row.ref)) ordered.push(row);
  return ordered;
}

// The same ordering, but built from intended defaults so it can be previewed
// before any roles are actually created.
function intendedEntries(guild) {
  const entries = [{ label: 'Giveaways', emoji: '🎉' }];
  for (const category of setup.proxyCategoriesInDiscordOrder(guild)) {
    entries.push({ label: category.label, emoji: CATEGORY_EMOJI[category.key] || null });
  }
  for (const row of db.listPingRoles()) {
    if (String(row.ref).startsWith('custom:')) entries.push({ label: row.label, emoji: row.emoji });
  }
  return entries;
}

// Buttons show only the emoji (falling back to the label when there is no valid
// emoji). The message body maps each label to its emoji so people know which is
// which. No embed, so there is no coloured stripe down the side.
function renderPanel(entries, { disabled = false } = {}) {
  const capped = entries.slice(0, 25);
  const lines = capped.map((entry) => (entry.emoji ? `${entry.label}: ${entry.emoji}` : entry.label));
  // An embed with no colour set has only Discord's neutral default border, not
  // a coloured accent stripe.
  const embed = new EmbedBuilder()
    .setTitle('Notification Roles')
    .setDescription(`Click a button to toggle a ping role on or off.\n\n${lines.join('\n') || 'No roles yet.'}`);
  const rows = [];
  let index = 0;
  for (let i = 0; i < capped.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const entry of capped.slice(i, i + 5)) {
      const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
        .setCustomId(entry.id ? `pr:t:${entry.id}` : `pr:x:${index}`);
      if (!entry.emoji || !applyEmoji(button, entry.emoji)) button.setLabel(String(entry.label || 'role').slice(0, 80));
      row.addComponents(button);
      index += 1;
    }
    rows.push(row);
  }
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

function livePanel(guild) {
  const entries = orderedRoles(guild).map((row) => ({ label: row.label, emoji: row.emoji, id: row.id }));
  return renderPanel(entries);
}

function previewPanel(guild) {
  return renderPanel(intendedEntries(guild), { disabled: true });
}

async function refreshPanel(client) {
  const channelId = db.getSetting('pingrole_channel');
  const messageId = db.getSetting('pingrole_message');
  if (!channelId || !messageId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;
  await message.edit(livePanel(channel.guild)).catch(() => {});
  return true;
}

async function post(guild, channel) {
  await seedDefaults(guild);
  const message = await channel.send(livePanel(guild));
  db.setSetting('pingrole_channel', channel.id);
  db.setSetting('pingrole_message', message.id);
  return message;
}

async function handleToggle(interaction, parts) {
  if (parts[1] !== 't') return null; // ignore disabled preview buttons
  // Acknowledge before touching the API: role lookups are REST calls and
  // Discord drops the interaction if nothing replies within three seconds.
  await interaction.deferReply({ flags: EPH }).catch(() => {});
  const row = db.getPingRole(parseInt(parts[2], 10));
  if (!row) {
    return interaction.editReply('That role is no longer available.').catch(() => {});
  }
  const role = interaction.guild.roles.cache.get(row.role_id)
    || await interaction.guild.roles.fetch(row.role_id).catch(() => null);
  if (!role) {
    return interaction.editReply('That role was deleted. Ask staff to fix the roles panel.').catch(() => {});
  }
  const me = interaction.guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || role.comparePositionTo(me.roles.highest) >= 0) {
    return interaction.editReply('I cannot assign that role. Ask staff to move my role above it.').catch(() => {});
  }
  const hasRole = interaction.member.roles.cache.has(role.id);
  try {
    if (hasRole) await interaction.member.roles.remove(role, 'Ping role toggled off');
    else await interaction.member.roles.add(role, 'Ping role toggled on');
  } catch (err) {
    return interaction.editReply('Could not update that role, try again.').catch(() => {});
  }
  return interaction.editReply({
    content: `${hasRole ? 'Removed' : 'Added'} **${row.label}**.`,
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

module.exports = { seedDefaults, addCustom, post, refreshPanel, previewPanel, livePanel, handleToggle, ensureRole, renderPanel };
