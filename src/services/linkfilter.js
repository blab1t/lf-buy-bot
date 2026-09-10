const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');
const config = require('../config');
const { isStaffOrHigher } = require('../util/perms');

// Matches bare domains as well as full URLs, so "oguser.com/thread" and
// "https://example.com" are both caught.
const URL_RE = /(?:https?:\/\/|www\.)[^\s<]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<]*)?/gi;

// Only server invites are blocked. Discord's own media, emoji, sticker and
// message links are normal chat content and stay allowed.
const DISCORD_INVITE_RE = new RegExp([
  '(?:https?://)?(?:[a-z0-9-]+\\.)*discord(?:app)?\\.(?:com|gg)/invite/[A-Za-z0-9-]+',
  '(?:https?://)?(?:www\\.)?discord\\.gg/[A-Za-z0-9-]+',
  '(?:https?://)?(?:www\\.)?(?:dsc\\.gg|dis\\.gd|invite\\.gg|discord\\.me|disboard\\.org|discadia\\.com)/[A-Za-z0-9-]+',
  '(?:https?://)?(?:www\\.)?top\\.gg/servers?/\\d+',
].join('|'), 'i');
// "gg/name" and ".gg/name" written without a real domain in front.
const GG_SHORTHAND_RE = /(?<![\w./])\.?gg\/[A-Za-z0-9-]{2,32}/i;
// A bare "/name" invite shorthand. Must start the token (so "and/or", "12/05"
// and "he/him" are untouched) and start with a letter.
const BARE_SLASH_RE = /(?<![\w/.])\/([A-Za-z][A-Za-z0-9-]{1,31})\b/g;

// Marketplaces staff actually use, plus Discord's own media/CDN/message links
// (GIFs, stickers, emoji, attachments and channel jump links).
const DEFAULT_ALLOW = [
  'oguser.com', 'ogusers.com',
  'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gift',
  'tenor.com', 'giphy.com', 'imgur.com', 'prnt.sc', 'gyazo.com',
  'mc-heads.net', 'namemc.com', 'minotar.net',
];

// "/close" in conversation is a bot command, not an invite.
let commandNameCache = null;
function botCommandNames() {
  if (commandNameCache) return commandNameCache;
  try {
    commandNameCache = new Set(require('../commands/definitions').map((d) => d.name.toLowerCase()));
  } catch (err) {
    commandNameCache = new Set();
  }
  return commandNameCache;
}
// Everyday phrases people type with a leading slash.
const SLASH_ALLOWED_WORDS = new Set([
  'me', 'yes', 'no', 'ok', 'or', 'and', 'per', 'off', 'on', 'ea', 'each', 'hr', 'day', 'week',
  'month', 'year', 'usd', 'eur', 'btc', 'eth', 'ltc', 'gg', 'w', 'l', 's', 'o',
]);

function findInviteShorthand(content) {
  const text = String(content || '');
  const hits = [];
  if (DISCORD_INVITE_RE.test(text)) hits.push('server invite');
  if (GG_SHORTHAND_RE.test(text)) hits.push('gg/ invite');
  const commands = botCommandNames();
  let match;
  BARE_SLASH_RE.lastIndex = 0;
  while ((match = BARE_SLASH_RE.exec(text))) {
    const word = match[1].toLowerCase();
    if (commands.has(word) || SLASH_ALLOWED_WORDS.has(word)) continue;
    hits.push(`/${match[1]}`);
  }
  return [...new Set(hits)];
}

function enabled() {
  return db.getSetting('linkfilter_enabled') === '1';
}
function setEnabled(on) {
  db.setSetting('linkfilter_enabled', on ? '1' : '0');
}

function allowList() {
  try {
    const raw = JSON.parse(db.getSetting('linkfilter_allow') || 'null');
    if (Array.isArray(raw)) return raw;
  } catch (err) {
    // fall through to the defaults
  }
  return [...DEFAULT_ALLOW];
}
function saveAllowList(list) {
  db.setSetting('linkfilter_allow', JSON.stringify([...new Set(list)]));
}
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.-]/g, '');
}
function addDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain || !domain.includes('.')) throw new Error('Enter a domain like `oguser.com`.');
  const list = allowList();
  if (list.includes(domain)) throw new Error('That domain is already allowed.');
  list.push(domain);
  saveAllowList(list);
  return domain;
}
function removeDomain(value) {
  const domain = normalizeDomain(value);
  const list = allowList();
  const next = list.filter((entry) => entry !== domain);
  if (next.length === list.length) throw new Error('That domain is not on the allow list.');
  saveAllowList(next);
  return domain;
}

function hostOf(match) {
  const host = String(match)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  return host;
}

// A domain is allowed when it matches an entry exactly or is a subdomain of one.
function isAllowedHost(host, list) {
  return list.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// Returns everything blockable in a message: disallowed domains plus Discord
// links and invite shorthands like "gg/name" or "/name".
function findDisallowed(content) {
  const list = allowList();
  const bad = [];
  const matches = String(content || '').match(URL_RE);
  for (const match of matches || []) {
    const host = hostOf(match);
    if (!host.includes('.')) continue;
    // Ignore things like "1.5" or file names such as "image.png".
    if (/^\d+(\.\d+)*$/.test(host)) continue;
    if (!/\.[a-z]{2,}$/i.test(host)) continue;
    if (!isAllowedHost(host, list)) bad.push(host);
  }
  for (const hit of findInviteShorthand(content)) {
    // Invites stay blocked unless the invite host itself was allowlisted.
    if (hit === 'server invite' && list.some((d) => /^(discord\.gg|dsc\.gg|invite\.gg|discord\.me)$/i.test(d))) continue;
    if (hit === 'gg/ invite' && list.some((d) => /\bgg$/i.test(d))) continue;
    bad.push(hit);
  }
  return [...new Set(bad)];
}

// Staff, admins and the bot owner are never filtered.
function isExempt(member, guild) {
  if (!member) return true;
  if (member.user && member.user.bot) return true;
  return isStaffOrHigher(member, guild);
}

// Called for every user message. Deletes disallowed links and warns briefly.
async function handleMessage(message) {
  try {
    if (!enabled()) return false;
    if (!message.guild || message.author.bot) return false;
    if (isExempt(message.member, message.guild)) return false;
    const bad = findDisallowed(message.content);
    if (!bad.length) return false;
    const me = message.guild.members.me;
    const perms = message.channel.permissionsFor(me);
    if (!perms || !perms.has(PermissionFlagsBits.ManageMessages)) return false;
    await message.delete().catch(() => {});
    const ticketsChannelId = db.getSetting('tickets_channel');
    const notice = await message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Message removed by the link filter')
        .setDescription(
          `<@${message.author.id}>, your message was flagged because links are not allowed here.\n` +
          `Flagged: \`${bad.slice(0, 3).join('`, `')}\`\n\n` +
          `If you think this was a mistake, open a ticket${ticketsChannelId ? ` in <#${ticketsChannelId}>` : ''} and staff will take a look.`
        )],
      allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    // Keep it visible long enough to read, then tidy up.
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 20000);
    // Send the same note by DM so it is not missed if the notice disappears.
    await message.author.send({
      embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Your message was removed')
        .setDescription(
          `Your message in **${message.guild.name}** (<#${message.channelId}>) was removed because links are not allowed there.\n` +
          `Flagged: \`${bad.slice(0, 3).join('`, `')}\`\n\n` +
          'If you believe this was a mistake, open a ticket in the server and staff will review it.\n\n' +
          `Your message:\n>>> ${String(message.content || '').slice(0, 1500)}`
        )],
    }).catch(() => {}); // closed DMs are fine
    const logs = require('./logs');
    logs.send(message.client, {
      title: 'Link blocked',
      description: `<@${message.author.id}> in <#${message.channelId}>`,
      fields: [
        { name: 'Blocked', value: bad.join(', ').slice(0, 1000), inline: false },
        { name: 'Message', value: String(message.content || '').slice(0, 900) || '-', inline: false },
      ],
      color: 0xed4245,
    });
    return true;
  } catch (err) {
    console.error('Link filter error:', err.message);
    return false;
  }
}

module.exports = {
  enabled, setEnabled, allowList, addDomain, removeDomain, normalizeDomain,
  findDisallowed, handleMessage, DEFAULT_ALLOW,
};
