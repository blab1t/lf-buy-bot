const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const db = require('../db');
const invites = require('./invites');
const { EMBED_COLOR } = require('../config');

const EPH = MessageFlags.Ephemeral;

// Role and minimum-invite gates checked both on entry and again at draw time.
function meetsRequirements(member, giveaway) {
  if (giveaway.required_role_id && !member.roles.cache.has(giveaway.required_role_id)) {
    return { ok: false, reason: `You need the <@&${giveaway.required_role_id}> role to enter this giveaway.` };
  }
  if (giveaway.min_invites > 0) {
    const count = invites.getInviteCount(member.id);
    if (count < giveaway.min_invites) {
      return { ok: false, reason: `You need at least **${giveaway.min_invites}** invites to enter (you have **${count}**).` };
    }
  }
  return { ok: true };
}

function enterRow(giveawayId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw:enter:${giveawayId}`)
      .setLabel('Enter')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎉')
      .setDisabled(disabled)
  );
}

function requirementLines(giveaway) {
  const lines = [];
  if (giveaway.required_role_id) lines.push(`Required role: <@&${giveaway.required_role_id}>`);
  if (giveaway.min_invites > 0) lines.push(`Minimum invites: **${giveaway.min_invites}**`);
  if (giveaway.goal_invites) lines.push(`🏁 **Invite race:** first entrant to **${giveaway.goal_invites}** invites since start wins!`);
  return lines;
}

function activeEmbed(giveaway, entryCount) {
  const seconds = Math.floor(giveaway.end_at / 1000);
  const endsLine = giveaway.end_at
    ? `Ends: <t:${seconds}:R> (<t:${seconds}:f>)`
    : 'Ends: when a host ends it';
  const reqs = requirementLines(giveaway);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`🎉 Giveaway: ${giveaway.prize}`.slice(0, 256))
    .setDescription(
      'Click **Enter** below to join!\n\n' +
      `Winners: **${giveaway.winners}**\n` +
      `Entries: **${entryCount}**\n` +
      `${endsLine}\n` +
      `Hosted by: <@${giveaway.host_id}>` +
      (reqs.length ? `\n\n${reqs.join('\n')}` : '')
    );
  if (giveaway.end_at) embed.setTimestamp(new Date(giveaway.end_at));
  return embed;
}

function endedEmbed(giveaway, winnerIds, entryCount) {
  const won = (winnerIds && winnerIds.length)
    ? `Winner${winnerIds.length > 1 ? 's' : ''}: ${winnerIds.map((id) => `<@${id}>`).join(', ')}`
    : 'No valid entries, so no winner was drawn.';
  return new EmbedBuilder()
    .setColor(giveaway.status === 'cancelled' ? 0xed4245 : EMBED_COLOR)
    .setTitle(`🎉 Giveaway ${giveaway.status === 'cancelled' ? 'cancelled' : 'ended'}: ${giveaway.prize}`.slice(0, 256))
    .setDescription(
      giveaway.status === 'cancelled'
        ? `This giveaway was cancelled.\nHosted by: <@${giveaway.host_id}>`
        : `${won}\nEntries: **${entryCount}**\nHosted by: <@${giveaway.host_id}>`
    )
    .setTimestamp(new Date());
}

function parseWinnerIds(giveaway) {
  try {
    return JSON.parse(giveaway.winner_ids || '[]');
  } catch (err) {
    return [];
  }
}

function pickWinners(entryIds, count, exclude = []) {
  const pool = entryIds.filter((id) => !exclude.includes(id));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, count));
}

// Re-render the giveaway's own message to match its current state.
async function updateMessage(client, giveaway, entryCount = null) {
  if (!giveaway.message_id) return;
  const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
  if (!message) return;
  const count = entryCount === null ? db.giveawayEntryCount(giveaway.id) : entryCount;
  if (giveaway.status === 'active') {
    await message.edit({ embeds: [activeEmbed(giveaway, count)], components: [enterRow(giveaway.id)] }).catch(() => {});
  } else {
    await message.edit({
      embeds: [endedEmbed(giveaway, parseWinnerIds(giveaway), count)],
      components: [enterRow(giveaway.id, true)],
    }).catch(() => {});
  }
}

function giveawayLink(giveaway, guildId) {
  return `https://discord.com/channels/${guildId}/${giveaway.channel_id}/${giveaway.message_id}`;
}

async function announceWinners(client, giveaway, winnerIds, { reroll = false, race = false } = {}) {
  const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
  if (!channel) return;
  if (!winnerIds.length) {
    await channel.send({
      content: `No valid entries for **${giveaway.prize}**, so no winner could be drawn.`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    return;
  }
  const mentions = winnerIds.map((id) => `<@${id}>`).join(', ');
  const link = giveaway.message_id ? `\n${giveawayLink(giveaway, channel.guildId)}` : '';
  const lead = race
    ? `🏁 ${mentions} hit **${giveaway.goal_invites}** invites first and won`
    : `${reroll ? '🎉 New winner drawn' : '🎉 Congratulations'} ${mentions}! You won`;
  await channel.send({
    content: `${lead} **${giveaway.prize}**.${link}`,
    allowedMentions: { users: winnerIds },
  }).catch(() => {});
}

// Members who left the server, lost the required role, or dropped below the
// minimum invites are filtered out before winners are drawn.
async function filterEligible(client, giveaway, entryIds) {
  if (!giveaway.required_role_id && !giveaway.min_invites) return entryIds.slice();
  const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
  const guild = channel ? channel.guild : null;
  if (!guild) return entryIds.slice();
  const eligible = [];
  for (const id of entryIds) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && meetsRequirements(member, giveaway).ok) eligible.push(id);
  }
  return eligible;
}

async function start(interaction, { prize, winners, durationMs, channel = null, hostId = null, requiredRoleId = null, minInvites = 0, goalInvites = null }) {
  const targetChannel = channel || interaction.channel;
  // endAt of 0 means "no timer": the giveaway runs until a host ends it (or,
  // for an invite race, until someone reaches the goal).
  const endAt = durationMs ? Date.now() + durationMs : 0;
  const giveaway = db.createGiveaway({
    channelId: targetChannel.id,
    prize,
    winners,
    hostId: hostId || interaction.user.id,
    endAt,
    requiredRoleId,
    minInvites,
    goalInvites,
  });
  const message = await targetChannel.send({
    embeds: [activeEmbed(giveaway, 0)],
    components: [enterRow(giveaway.id)],
  });
  db.setGiveawayMessage(giveaway.id, message.id);
  return db.getGiveaway(giveaway.id);
}

// Toggle a user's entry from the Enter button.
async function toggleEntry(interaction, parts) {
  const giveaway = db.getGiveaway(parseInt(parts[2], 10));
  if (!giveaway || giveaway.status !== 'active') {
    return interaction.reply({ content: 'This giveaway is no longer open.', flags: EPH }).catch(() => {});
  }
  const alreadyEntered = db.giveawayEntryIds(giveaway.id).includes(interaction.user.id);
  let message;
  if (alreadyEntered) {
    db.removeGiveawayEntry(giveaway.id, interaction.user.id);
    message = 'You left the giveaway.';
  } else {
    const check = meetsRequirements(interaction.member, giveaway);
    if (!check.ok) {
      return interaction.reply({ content: check.reason, flags: EPH, allowedMentions: { parse: [] } }).catch(() => {});
    }
    db.addGiveawayEntry(giveaway.id, interaction.user.id);
    message = 'You are entered. Good luck! 🎉 Press Enter again to leave.';
    if (giveaway.goal_invites) {
      const progress = invites.invitesSince(interaction.user.id, giveaway.created_at);
      message += `\nInvite race progress: **${progress}/${giveaway.goal_invites}** invites since this giveaway started.`;
    } else if (giveaway.min_invites > 0) {
      message += `\nYou have **${invites.getInviteCount(interaction.user.id)}** invites.`;
    }
  }
  await interaction.reply({ content: message, flags: EPH, allowedMentions: { parse: [] } }).catch(() => {});
  await updateMessage(interaction.client, db.getGiveaway(giveaway.id));
  return null;
}

async function endNow(client, giveawayRow, { announce = true } = {}) {
  const giveaway = db.getGiveaway(giveawayRow.id);
  if (!giveaway || giveaway.status !== 'active') return null;
  const entryIds = db.giveawayEntryIds(giveaway.id);
  const eligible = await filterEligible(client, giveaway, entryIds);
  const winnerIds = pickWinners(eligible, giveaway.winners);
  db.finishGiveaway(giveaway.id, winnerIds, 'ended');
  const updated = db.getGiveaway(giveaway.id);
  await updateMessage(client, updated, entryIds.length);
  if (announce) await announceWinners(client, updated, winnerIds);
  return updated;
}

// Ends a giveaway with a predetermined winner list (used by the invite race).
async function endWithWinners(client, giveawayRow, winnerIds, opts = {}) {
  const giveaway = db.getGiveaway(giveawayRow.id);
  if (!giveaway || giveaway.status !== 'active') return null;
  db.finishGiveaway(giveaway.id, winnerIds, 'ended');
  const updated = db.getGiveaway(giveaway.id);
  await updateMessage(client, updated, db.giveawayEntryCount(giveaway.id));
  await announceWinners(client, updated, winnerIds, opts);
  return updated;
}

// Called whenever an inviter is credited a new invite. Ends any invite-race
// giveaway the inviter has entered once they reach its goal.
async function onInviteCredited(client, inviterId) {
  for (const row of db.goalGiveaways()) {
    const giveaway = db.getGiveaway(row.id);
    if (!giveaway || giveaway.status !== 'active') continue;
    if (!db.giveawayEntryIds(giveaway.id).includes(inviterId)) continue;
    const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
    const guild = channel ? channel.guild : null;
    const member = guild ? await guild.members.fetch(inviterId).catch(() => null) : null;
    if (!member || !meetsRequirements(member, giveaway).ok) continue;
    if (invites.invitesSince(inviterId, giveaway.created_at) >= giveaway.goal_invites) {
      await endWithWinners(client, giveaway, [inviterId], { race: true });
    }
  }
}

async function reroll(client, giveawayRow, count) {
  const giveaway = db.getGiveaway(giveawayRow.id);
  if (!giveaway || giveaway.status !== 'ended') return { ok: false, reason: 'That giveaway has not ended yet.' };
  const entryIds = db.giveawayEntryIds(giveaway.id);
  if (!entryIds.length) return { ok: false, reason: 'That giveaway had no entries to reroll.' };
  const previous = parseWinnerIds(giveaway);
  let winnerIds = pickWinners(entryIds, count || giveaway.winners, previous);
  if (!winnerIds.length) winnerIds = pickWinners(entryIds, count || giveaway.winners); // everyone already won
  db.setGiveawayWinners(giveaway.id, winnerIds);
  const updated = db.getGiveaway(giveaway.id);
  await updateMessage(client, updated, entryIds.length);
  await announceWinners(client, updated, winnerIds, { reroll: true });
  return { ok: true, winnerIds };
}

async function cancel(client, giveawayRow) {
  const giveaway = db.getGiveaway(giveawayRow.id);
  if (!giveaway || giveaway.status !== 'active') return { ok: false, reason: 'That giveaway is not active.' };
  db.finishGiveaway(giveaway.id, [], 'cancelled');
  await updateMessage(client, db.getGiveaway(giveaway.id));
  return { ok: true };
}

async function sweep(client) {
  for (const row of db.dueGiveaways(Date.now())) {
    await endNow(client, row).catch((err) => console.error('Giveaway end failed:', err.message));
  }
}

module.exports = {
  start, toggleEntry, endNow, reroll, cancel, sweep, onInviteCredited,
  activeEmbed, enterRow, meetsRequirements,
};
