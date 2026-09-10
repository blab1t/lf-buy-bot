const { AttachmentBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const db = require('../db');
const config = require('../config');

// Reads a whole channel (oldest first). Discord only returns 100 at a time.
async function fetchAllMessages(channel, cap = 2000) {
  const all = [];
  let before;
  while (all.length < cap) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!page || !page.size) break;
    all.push(...page.values());
    before = page.last().id;
    if (page.size < 100) break;
  }
  return all.reverse();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function describeAttachments(message) {
  const parts = [];
  for (const attachment of message.attachments.values()) parts.push(attachment.url);
  for (const embed of message.embeds || []) {
    const bits = [embed.title, embed.description].filter(Boolean).join(' - ');
    if (bits) parts.push(`[embed] ${bits}`);
  }
  return parts;
}

function renderText(channel, messages, ticket) {
  const lines = [
    `Transcript of #${channel.name}`,
    ticket ? `Ticket #${ticket.number} (${ticket.type}), opened by ${ticket.creator_id}` : '',
    `Channel ID: ${channel.id}`,
    `Messages: ${messages.length}`,
    `Generated: ${new Date().toISOString()}`,
    ''.padEnd(60, '-'),
    '',
  ].filter(Boolean);
  for (const message of messages) {
    const stamp = new Date(message.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const author = `${message.author.tag}${message.author.bot ? ' [bot]' : ''}`;
    lines.push(`[${stamp}] ${author}: ${message.content || ''}`.trimEnd());
    for (const extra of describeAttachments(message)) lines.push(`    ${extra}`);
  }
  return lines.join('\n');
}

function renderHtml(channel, messages, ticket) {
  const rows = messages.map((message) => {
    const stamp = new Date(message.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const extras = describeAttachments(message)
      .map((extra) => `<div class="extra">${escapeHtml(extra)}</div>`).join('');
    return `<div class="msg"><span class="time">${stamp}</span> <span class="author">${escapeHtml(message.author.tag)}${message.author.bot ? ' <span class="bot">BOT</span>' : ''}</span><div class="text">${escapeHtml(message.content)}</div>${extras}</div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Transcript #${escapeHtml(channel.name)}</title>
<style>body{background:#313338;color:#dbdee1;font-family:system-ui,sans-serif;margin:0;padding:24px}
h1{font-size:18px;margin:0 0 4px}.meta{color:#949ba4;font-size:13px;margin-bottom:16px}
.msg{padding:6px 0;border-bottom:1px solid #3f4147}.time{color:#949ba4;font-size:12px}
.author{font-weight:600;color:#f2f3f5}.bot{background:#5865f2;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px}
.text{white-space:pre-wrap;margin-top:2px}.extra{color:#00a8fc;font-size:13px;margin-top:2px;word-break:break-all}</style></head>
<body><h1>#${escapeHtml(channel.name)}</h1>
<div class="meta">${ticket ? `Ticket #${ticket.number} (${ticket.type}) · opened by &lt;@${ticket.creator_id}&gt; · ` : ''}${messages.length} messages · generated ${new Date().toISOString()}</div>
${rows}</body></html>`;
}

// Builds both files for a channel. Returns null when there is nothing to save.
async function build(channel, ticket = null) {
  if (!channel || typeof channel.messages?.fetch !== 'function') return null;
  const messages = await fetchAllMessages(channel);
  if (!messages.length) return null;
  const base = `transcript-${channel.name}-${channel.id}`.slice(0, 90).replace(/[^a-z0-9_-]+/gi, '-');
  const text = renderText(channel, messages, ticket);
  return {
    messages,
    text,
    files: [
      new AttachmentBuilder(Buffer.from(renderHtml(channel, messages, ticket), 'utf8'), { name: `${base}.html` }),
      new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${base}.txt` }),
    ],
  };
}

// Some guilds have file uploads restricted by Discord. In that case the
// transcript is posted as plain text instead of being lost.
const CHUNK = 1900;
const MAX_CHUNKS = 12;

function textChunks(text) {
  const lines = String(text).split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const piece = line.length > CHUNK ? `${line.slice(0, CHUNK - 3)}...` : line;
    if (current.length + piece.length + 1 > CHUNK) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function uploadBlocked(err) {
  return /file uploads|attach|Missing Permissions|payload/i.test(String(err && err.message));
}

// Sends the transcript to one destination, falling back to text when the guild
// cannot accept attachments. Returns 'files', 'text' or false.
async function deliver(target, built, { header = null } = {}) {
  if (!target || typeof target.send !== 'function') return false;
  try {
    await target.send({ ...(header ? { content: header } : {}), ...built.payloadWithFiles });
    return 'files';
  } catch (err) {
    if (!uploadBlocked(err)) {
      console.error(`Transcript send failed: ${err.message}`);
      return false;
    }
    // Uploads are blocked here: post the conversation inline instead.
    const chunks = textChunks(built.text);
    const shown = chunks.slice(0, MAX_CHUNKS);
    try {
      await target.send({
        ...(header ? { content: header } : {}),
        ...(built.payloadWithoutFiles || {}),
        allowedMentions: { parse: [] },
      });
      for (const chunk of shown) {
        await target.send({ content: `\`\`\`\n${chunk}\n\`\`\``, allowedMentions: { parse: [] } });
      }
      if (chunks.length > shown.length) {
        await target.send({
          content: `_Transcript truncated: ${chunks.length - shown.length} more block(s). File uploads are restricted in this server, so it could not be attached in full._`,
          allowedMentions: { parse: [] },
        });
      }
      return 'text';
    } catch (innerErr) {
      console.error(`Transcript text fallback failed: ${innerErr.message}`);
      return false;
    }
  }
}

function summaryEmbed(channel, ticket, messageCount) {
  const embed = new EmbedBuilder()
    .setColor(config.EMBED_COLOR)
    .setTitle(`Transcript - #${channel.name}`)
    .setDescription([
      ticket ? `Ticket **#${ticket.number}** (${ticket.type})` : null,
      ticket ? `Opened by <@${ticket.creator_id}>` : null,
      `Messages: **${messageCount}**`,
    ].filter(Boolean).join('\n'))
    .setTimestamp(new Date());
  return embed;
}

// Saves a transcript to the configured channel and DMs it to the ticket owner.
// Everything is best-effort: a failed DM must never block a ticket from closing.
async function archive(client, channel, ticket, { dmUser = true, extraDmIds = [] } = {}) {
  const built = await build(channel, ticket).catch((err) => {
    console.error('Transcript build failed:', err.message);
    return null;
  });
  if (!built) return { saved: false, dmed: false, messages: 0 };

  // A transcript must never be lost: use the configured channel, create one if
  // there is none, and fall back to the audit log if even that fails. When the
  // guild cannot accept uploads the text is posted inline instead.
  const logs = require('./logs');
  const summary = summaryEmbed(channel, ticket, built.messages.length);
  built.payloadWithFiles = { embeds: [summary], files: built.files };
  built.payloadWithoutFiles = { embeds: [summary] };

  const trySend = async (target) => {
    if (!target || target.type !== ChannelType.GuildText) return false;
    const mode = await deliver(target, built);
    if (mode === 'text') console.log(`Transcript for #${channel.name} posted as text in #${target.name} (uploads restricted).`);
    return Boolean(mode);
  };

  let saved = false;
  const archiveId = db.getSetting('transcript_channel');
  if (archiveId) {
    saved = await trySend(await client.channels.fetch(archiveId).catch(() => null));
  }
  if (!saved && channel.guild) {
    // No channel configured (or it is gone/unwritable): make one and use it.
    const created = await logs.ensureLogChannel(channel.guild, 'transcripts', 'transcripts').catch((err) => {
      console.error('Could not create a transcripts channel:', err.message);
      return null;
    });
    if (created && created.channel && created.channel.id !== archiveId) {
      saved = await trySend(created.channel);
    }
  }
  if (!saved) {
    const auditId = logs.channelIdFor('audit');
    if (auditId) saved = await trySend(await client.channels.fetch(auditId).catch(() => null));
  }
  // Last resort: hand it to the owner directly, with the reason it failed.
  if (!saved) {
    console.error(`Transcript for #${channel.name} could not be archived anywhere.`);
    const ownerId = config.OWNER_ID || (channel.guild ? channel.guild.ownerId : null);
    if (ownerId) {
      const owner = await client.users.fetch(ownerId).catch(() => null);
      if (owner) {
        const header = `⚠️ I could not archive the transcript of **#${channel.name}**`
          + `${ticket && ticket.number ? ` (ticket #${ticket.number})` : ''} in **${channel.guild ? channel.guild.name : 'the server'}**.\n`
          + 'Discord refused the upload and no log channel accepted it, so here is the conversation directly.';
        saved = Boolean(await deliver(owner, built, { header }).catch(() => false));
      }
    }
  }

  // Always DM the ticket owner, plus anyone explicitly named.
  const recipients = new Set();
  if (dmUser && ticket && ticket.creator_id) recipients.add(String(ticket.creator_id));
  for (const id of extraDmIds || []) if (id) recipients.add(String(id));

  let dmed = 0;
  const header = ticket && ticket.number
    ? `Here is the transcript of ticket **#${ticket.number}** in **${channel.guild ? channel.guild.name : 'the server'}**.`
    : `Here is the transcript of **#${channel.name}** in **${channel.guild ? channel.guild.name : 'the server'}**.`;
  for (const id of recipients) {
    const user = await client.users.fetch(id).catch(() => null);
    if (!user) continue;
    // Same upload restriction can apply to DMs, so reuse the text fallback.
    const mode = await deliver(user, built, { header }).catch(() => false);
    if (mode) dmed += 1;
  }
  return { saved, dmed: dmed > 0, dmCount: dmed, attempted: recipients.size, messages: built.messages.length };
}

module.exports = { build, archive, fetchAllMessages, renderText, renderHtml };
