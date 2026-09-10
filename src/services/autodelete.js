const db = require('../db');
const { PING_DELETE_MS } = require('../config');

// Registers a bot ping message: deleted when the target user speaks in the
// channel, or after the timeout (default 15 minutes). Survives restarts.
function registerPingDelete(message, targetId, ms = PING_DELETE_MS) {
  db.addPendingDelete(message.id, message.channelId, targetId, Date.now() + ms);
}

async function deleteTracked(client, row) {
  db.removePendingDelete(row.message_id);
  try {
    const channel = await client.channels.fetch(row.channel_id);
    if (!channel) return;
    const message = await channel.messages.fetch(row.message_id);
    if (message) await message.delete();
  } catch (err) {
    // channel or message already gone, nothing to do
  }
}

// Called from messageCreate: if the author was pinged by a tracked bot
// message in this channel, delete that bot message now.
async function onUserMessage(client, message) {
  const rows = db.pendingDeletesFor(message.channelId, message.author.id);
  for (const row of rows) await deleteTracked(client, row);
}

async function sweep(client) {
  const rows = db.duePendingDeletes(Date.now());
  for (const row of rows) await deleteTracked(client, row);
}

module.exports = { registerPingDelete, onUserMessage, sweep };
