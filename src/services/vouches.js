const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const { CH_VOUCHES_PREFIX, EMBED_COLOR } = require('../config');
const autodelete = require('./autodelete');

function stickyEmbed(count, leaderboard = []) {
  const leaderboardText = leaderboard.length
    ? leaderboard.map((entry, index) => `**#${index + 1}** <@${entry.user_id}>: **${entry.count}**`).join('\n')
    : 'No vouches have been recorded yet.';
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Vouches: ${count}`)
    .setDescription(
      '**Vouch Format**\nVouch <@user> <product purchased> <Small review about the service>\n\n' +
      '**Vouch Counts**\n' + leaderboardText
    );
}

function isVouch(message) {
  return !message.author.bot && message.mentions.users.some((user) => !user.bot);
}

async function updateSticky(channel, { repost = false } = {}) {
  const count = db.getVouchCount();
  const oldId = db.getSetting('vouch_sticky');
  const old = oldId ? await channel.messages.fetch(oldId).catch(() => null) : null;
  if (old && !repost) {
    await old.edit({ embeds: [stickyEmbed(count, db.getVouchLeaderboard())] }).catch(() => {});
    return old;
  }
  // A sticky needs to be the newest message. Repost it after a vouch instead
  // of merely editing its old position in the channel.
  if (old && repost) await old.delete().catch(() => {});
  const sticky = await channel.send({ embeds: [stickyEmbed(count, db.getVouchLeaderboard())] });
  db.setSetting('vouch_sticky', sticky.id);
  return sticky;
}

async function maybeRename(channel) {
  const wanted = `${CH_VOUCHES_PREFIX}-${db.getVouchCount()}`;
  if (channel.name === wanted) return false;
  try {
    await channel.setName(wanted, 'Keep the vouch count in the channel name');
    db.setSetting('vouch_last_rename', Date.now());
    return true;
  } catch (err) {
    console.error('Vouch rename failed:', err.message);
    return false;
  }
}

// Read all existing messages whenever a vouch channel is selected in setup.
// This makes the count accurate for an existing server before new vouches arrive.
async function recountHistory(channel) {
  const vouches = [];
  let before;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    for (const message of page.values()) {
      if (isVouch(message)) {
        vouches.push({
          id: message.id,
          createdTimestamp: message.createdTimestamp,
          userIds: message.mentions.users.filter((user) => !user.bot).map((user) => user.id),
        });
      }
    }
    before = page.last().id;
    if (page.size < 100) break;
  }
  const count = db.replaceVouchMessages(channel.id, vouches);
  db.setSetting('vouch_channel', channel.id);
  db.setSetting('vouch_leaderboard_channel', channel.id);
  await updateSticky(channel);
  await maybeRename(channel);
  return count;
}

// Called for every non-bot message in the configured vouches channel.
async function handleVouchMessage(message) {
  if (!isVouch(message)) {
    await updateSticky(message.channel, { repost: true });
    return false;
  }
  if (!db.recordVouchMessage(message.id, message.channelId, message.createdTimestamp)) return false;
  db.recordVouchMentions(
    message.id,
    message.mentions.users.filter((user) => !user.bot).map((user) => user.id)
  );
  db.setVouchCount(db.getVouchCount() + 1);
  await updateSticky(message.channel, { repost: true });
  await maybeRename(message.channel);
  return true;
}

// Keep the persisted count and per-user leaderboard accurate if staff removes
// a vouch message later.
async function handleVouchDelete(client, message) {
  const deleted = db.removeVouchMessage(message.id);
  if (!deleted) return false;
  if (deleted.channel_id !== db.getSetting('vouch_channel')) return true;
  db.setVouchCount(db.countVouchMessages(deleted.channel_id));
  const channel = message.channel || await client.channels.fetch(deleted.channel_id).catch(() => null);
  if (channel) {
    await updateSticky(channel, { repost: true });
    await maybeRename(channel);
  }
  return true;
}

// Registers a vouch staff added by hand from a message link. The vouch is
// stored against the configured vouches channel so counts stay consistent, and
// the recipient is credited on the leaderboard even if they were never pinged.
async function addManualVouch(vouchChannel, { messageId, voucherId, recipientId, createdAt }) {
  const result = db.addManualVouch(messageId, vouchChannel.id, voucherId, recipientId, createdAt || Date.now());
  db.setVouchCount(db.countVouchMessages(vouchChannel.id));
  await updateSticky(vouchChannel, { repost: true });
  await maybeRename(vouchChannel);
  return result;
}

async function vouchPing(channel, targetUser) {
  const message = await channel.send({
    content: `<@${targetUser.id}> Please leave a vouch here when you have a minute!`,
    allowedMentions: { users: [targetUser.id] },
  });
  autodelete.registerPingDelete(message, targetUser.id);
  await updateSticky(channel, { repost: true });
  return message;
}

async function renameSweep(client) {
  const channelId = db.getSetting('vouch_channel');
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel) await maybeRename(channel);
}

// Older installations stored only the total. Read the configured channel once
// after this update so the new per-user leaderboard includes its history too.
async function ensureLeaderboardHistory(client) {
  const channelId = db.getSetting('vouch_channel');
  if (!channelId || db.getSetting('vouch_leaderboard_channel') === channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== 'function') return false;
  await recountHistory(channel);
  return true;
}

module.exports = {
  stickyEmbed, updateSticky, maybeRename, recountHistory,
  handleVouchMessage, handleVouchDelete, vouchPing, addManualVouch, renameSweep, ensureLeaderboardHistory,
};
