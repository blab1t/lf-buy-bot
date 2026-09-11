const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  SectionBuilder, ThumbnailBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const { EmbedBuilder } = require('discord.js');
const capes = require('./capes');
const db = require('../db');
const proxyCategories = require('./proxyCategories');

// A request describes what somebody is LOOKING FOR, so every field is a
// requirement rather than a property of something that already exists.
// Discord allows 5 inputs per modal, so no field set below may exceed 5.
const FIELDS = {
  ranks: { key: 'ranks', label: 'Wanted ranks / NWL', placeholder: 'MVP+ or higher | NWL 100+' },
  stats: { key: 'stats', label: 'Wanted stats', placeholder: 'BW 300+ stars, 3+ FKDR | SW any' },
  incidents: { key: 'incidents', label: 'Incidents (bans, history, access)', prefix: 'Status', placeholder: 'Unbanned, clean history, full access only' },
  namechanges: { key: 'namechanges', label: 'Name changes allowed', prefix: 'Name changes', placeholder: '0nc only, or max 2' },
  nametype: { key: 'nametype', label: 'Type of name', prefix: 'Name type', placeholder: '3cn digits, 4-letter word, OG single word' },
  capecount: { key: 'capecount', label: 'How many capes', prefix: 'Capes', placeholder: 'at least 3, or any' },
  capenotes: { key: 'capenotes', label: 'Specific capes / cape codes', prefix: 'Capes wanted', placeholder: 'Migrator + Vanilla, or an unredeemed code' },
  quicksell: { key: 'quicksell', label: 'Quicksell / bulk terms', prefix: 'Bulk', placeholder: 'buying 10+ in bulk, price per account' },
  age: { key: 'age', label: 'Account age / creation date', prefix: 'Age', placeholder: '2015 or older' },
  badges: { key: 'badges', label: 'Badges / Nitro / boosts', prefix: 'Badges', placeholder: 'Early Supporter, HypeSquad, Nitro' },
  handle: { key: 'handle', label: 'Wanted handle / vanity', prefix: 'Handle', placeholder: '@short, 3-letter vanity' },
  members: { key: 'members', label: 'Members / subscribers / followers', prefix: 'Size', placeholder: '10k+, real not botted' },
  niche: { key: 'niche', label: 'Niche / content', prefix: 'Niche', placeholder: 'gaming, monetized, English audience' },
  platform: { key: 'platform', label: 'Platform / game', prefix: 'Platform', placeholder: 'Steam, Valorant, Xbox gamertag' },
  payment: { key: 'payment', label: 'Payment methods you can use', prefix: 'Payment method', placeholder: 'LTC, BTC, PayPal F&F' },
  extra: { key: 'extra', label: 'Other requirements (one per line)', placeholder: 'One requirement per line' },
};
// Every detail field is a paragraph box: requirements are sentences, not tags.
for (const field of Object.values(FIELDS)) field.multiline = true;

const FIELD_SETS = {
  ogs: ['nametype', 'namechanges', 'incidents', 'payment', 'extra'],
  semis: ['nametype', 'namechanges', 'incidents', 'payment', 'extra'],
  capes: ['capenotes', 'capecount', 'namechanges', 'incidents', 'extra'],
  stats: ['ranks', 'stats', 'incidents', 'payment', 'extra'],
  quickbuy: ['quicksell', 'stats', 'ranks', 'payment', 'extra'],
  other: ['stats', 'incidents', 'payment', 'platform', 'extra'],
};

const DEFAULT_FIELD_SET = ['stats', 'incidents', 'payment', 'platform', 'extra'];

// Categories where a cape picker makes sense at all.
const CAPE_CATEGORIES = new Set(['capes', 'stats', 'quickbuy']);

// Categories where a Minecraft name change count is meaningful.
const NAME_CHANGE_CATEGORIES = new Set(['ogs', 'semis', 'capes', 'stats']);

// "no", "none", "-" and friends mean the buyer does not care, so they are
// stored as nothing at all instead of showing up as a requirement.
const BLANK_ANSWERS = new Set([
  'no', 'non', 'none', 'nope', 'nah', 'n/a', 'na', 'nan', 'nil', 'null',
  'nein', 'keine', 'kein', 'k.a.', 'ka', '-', '--', '/', 'x', '.',
]);

function isBlankAnswer(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return true;
  return BLANK_ANSWERS.has(text.replace(/[.!]+$/, ''));
}

// What actually gets stored for a field: blank answers collapse to '', and a
// bare number in the name-changes field still reads as "12nc".
function cleanFieldValue(key, value) {
  const text = String(value == null ? '' : value).trim();
  if (isBlankAnswer(text)) return '';
  return key === 'namechanges' ? formatNameChanges(text) : text;
}

// One bullet per line the buyer wrote, with their own bullet characters kept
// rather than doubled, and the field's label in front of the first line when
// the answer would be meaningless on its own ("LTC, BTC" -> "Payment method: ...").
function fieldBullets(field, value) {
  if (isBlankAnswer(value)) return [];
  const lines = String(value).split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•‣▪]\s*)+/, '').trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const prefix = field && field.prefix ? `${field.prefix}: ` : '';
  return lines.map((line, index) => `- ${index === 0 ? prefix : ''}${line}`);
}

function infoFieldsForCategory(category) {
  const keys = FIELD_SETS[category] || DEFAULT_FIELD_SET;
  return keys.map((key) => FIELDS[key]);
}

// Every field that is not already in this kind's own modal, so a buyer can
// fill in anything at all - stats on a Discord request, badges on a name.
function extraFieldsForCategory(category) {
  const used = new Set((FIELD_SETS[category] || DEFAULT_FIELD_SET));
  return Object.values(FIELDS).filter((field) => !used.has(field.key));
}

// The menu of those extra fields. Filled ones say so, so a second pass edits
// them instead of looking like they were never asked.
function buildExtraFieldRow(customId, category, info = {}) {
  const options = extraFieldsForCategory(category).slice(0, 25).map((field) => ({
    label: field.label.slice(0, 100),
    value: field.key,
    description: info[field.key] ? String(info[field.key]).slice(0, 90) : undefined,
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Add anything else you want to specify')
    .setMinValues(1)
    .setMaxValues(Math.min(5, options.length))
    .addOptions(options);
  return new ActionRowBuilder().addComponents(select);
}

// A modal holding exactly the fields that were picked (Discord allows 5).
function buildPickedFieldsModal(customId, keys, values = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('More details');
  for (const key of keys.slice(0, 5)) {
    const field = FIELDS[key];
    if (field) modal.addComponents(textInput(field, values[key]));
  }
  return modal;
}

function wantsCapes(category) {
  return CAPE_CATEGORIES.has(category);
}

// Everything the wizard collects before the per-category detail fields. The
// kind is typed rather than picked from a menu, and the budget is one range
// field ("50-100") instead of two boxes.
function buildBasicsModal(customId, values = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('What are you looking for?');
  const rows = [
    new TextInputBuilder().setCustomId('ign')
      .setLabel('Short title').setStyle(TextInputStyle.Short)
      .setRequired(true).setMaxLength(80)
      .setPlaceholder('3-letter OG name, Migrator cape acc, 10k YT channel'),
    new TextInputBuilder().setCustomId('description')
      .setLabel('Describe it').setStyle(TextInputStyle.Paragraph)
      .setRequired(false).setMaxLength(1000)
      .setPlaceholder('Anything a seller should know before offering'),
    new TextInputBuilder().setCustomId('budget')
      .setLabel('What you pay (USD)').setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(64).setPlaceholder('e.g. 100; blank = open to offers'),
    new TextInputBuilder().setCustomId('amount')
      .setLabel('How many do you want?').setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(40).setPlaceholder('blank or 1 for a single one, 10+ for bulk'),
  ];
  for (const input of rows) {
    const value = values[input.data.custom_id];
    if (value !== undefined && value !== null && String(value).trim() && String(value) !== 'Offer') {
      input.setValue(String(value).slice(0, input.data.max_length || 100));
    }
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

// What the buyer typed back into the editable field.
function budgetInputValue(listing) {
  return listing.bin && listing.bin !== 'Offer' ? String(listing.bin) : '';
}

// Wanting one of something is the default, so only a real quantity is shown.
// 0 is a legitimate answer ("just looking") and stays off the card too.
function displayAmount(listing) {
  const text = listing.info ? String(listing.info.amount || '').trim() : '';
  if (!text) return null;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber <= 1) return null;
  return text;
}

// What the buyer pays, or "Offer" when they left it open.
function displayBudget(listing) {
  return displayUsdPrice(listing.bin);
}

function avatarUrl(listing) {
  return `https://mc-heads.net/avatar/${encodeURIComponent(listing.uuid || listing.ign)}/100`;
}

// The "ign" column holds the request title: either a concrete account the
// buyer is hunting for, or a short description like "3-letter OG name".
function displayIgn(listing) {
  if (!listing.ign_hidden) return listing.ign;
  if (listing.category === 'minecon') {
    const year = mineconYear(listing);
    return `${year ? `${year} Minecon` : 'Minecon'} (Hidden)`;
  }
  return 'Hidden';
}

// Only a request naming a real, resolved account gets a player head.
function hasAvatar(listing) {
  return Boolean(listing.uuid) && !listing.ign_hidden;
}

function normalizeUsdPrice(value) {
  const input = String(value || '').trim();
  if (!input || /^offer$/i.test(input)) return 'Offer';
  const withoutCurrency = input
    .replace(/^\$\s*/, '')
    .replace(/\s*usd\s*$/i, '')
    .replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(withoutCurrency) || Number(withoutCurrency) <= 0) {
    throw new Error('Enter a positive USD amount such as 100 or $100.00, or leave the field blank for Offer.');
  }
  const amount = Number(withoutCurrency);
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// Numeric USD value of a stored price, or null for "Offer"/blank/unparseable.
// Used to compare offers against the current C/O.
function usdToNumber(value) {
  const input = String(value || '').trim();
  if (!input || /^offer$/i.test(input)) return null;
  const cleaned = input.replace(/[^0-9.]/g, '');
  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// Legacy listings can still contain an older free-text value. New input is
// validated by normalizeUsdPrice; plain stored numbers are also rendered as USD.
function displayUsdPrice(value) {
  const input = String(value || '').trim();
  if (!input) return 'Offer';
  try {
    return normalizeUsdPrice(input);
  } catch (err) {
    return input;
  }
}

// Values used for arranging managed channels inside the Stats category.
// Prefer editable stats text, then fall back to the generated channel name.
function statSortValues(listing) {
  const sources = [listing.info && listing.info.stats, listing.name_suggestion]
    .filter(Boolean)
    .map((value) => String(value));
  const starMatch = sources.map((value) => value.match(/(\d+(?:\.\d+)?)\s*(?:⭐|stars?)/i)).find(Boolean);
  const fkdrMatch = sources.map((value) => value.match(/(\d+(?:\.\d+)?)\s*fkdr\b/i)).find(Boolean);
  const rawStars = starMatch ? Math.max(0, Number(starMatch[1])) : 0;
  const stars = rawStars < 50 ? Math.round(rawStars) : Math.round(rawStars / 50) * 50;
  const fkdr = fkdrMatch ? Math.max(0, Math.round(Number(fkdrMatch[1]))) : 0;
  return { stars, fkdr };
}

// "12" -> "12nc", but "12 nc" or a list of previous names is left alone.
function formatNameChanges(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  const bare = text.match(/^(\d+)\s*$/);
  return bare ? `${bare[1]}nc` : text;
}

function nameChangeCount(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const explicit = text.match(/^\s*(\d+)\s*(?:nc|name\s*changes?)?\s*$/i) ||
    text.match(/\b(\d+)\s*(?:nc|name\s*changes?)\b/i);
  if (explicit) return Math.max(0, parseInt(explicit[1], 10) || 0);
  return text.split(/[\r\n,;]+/).map((entry) => entry.trim()).filter(Boolean).length;
}

function mineconYear(listing) {
  for (const key of listing.capes || []) {
    const cape = capes.getCape(key);
    const match = `${key} ${cape ? cape.name : ''}`.match(/minecon[_ -]?(\d{4})/i);
    if (match) return match[1];
  }
  return null;
}

// Minecon channels use the requested year-namechanges format: e.g. 2011-12nc.
function mineconChannelName(listing) {
  return `${mineconYear(listing) || 'minecon'}-${nameChangeCount(listing.info && listing.info.namechanges)}nc`;
}

// 3-character names group as: digits (000-999), then letters (aaa-zzz), then
// anything containing an underscore or a mix.
function threeCharClass(ign) {
  const name = String(ign || '');
  if (/^\d{3}$/.test(name)) return 0;
  if (/^[A-Za-z]{3}$/.test(name)) return 1;
  return 2;
}

// Sort key per account category, compared element by element. Numbers sort
// ascending, so "best first" values are negated.
function listingSortKey(listing) {
  switch (listing.category) {
    case 'minecon':
      // Oldest Minecon first, then fewest name changes.
      return [Number(mineconYear(listing)) || 9999, nameChangeCount(listing.info && listing.info.namechanges)];
    case 'name':
      // Shortest wanted name on top: the rarer the name, the higher it sits.
      return [String(listing.ign || '').length, String(listing.ign || '').toLowerCase()];
    case 'capes':
    case 'capecode':
      return [threeCharClass(listing.ign), String(listing.ign || '').toLowerCase()];
    case 'mcacc': {
      const { stars, fkdr } = statSortValues(listing);
      return [-stars, -fkdr];
    }
    default: {
      // Everything else (high tier, cosmetics, custom categories): dearest first.
      const price = usdToNumber(listing.bin) ?? usdToNumber(listing.co) ?? 0;
      return [-price, String(listing.ign || '').toLowerCase()];
    }
  }
}

function compareListings(a, b) {
  const keyA = listingSortKey(a);
  const keyB = listingSortKey(b);
  for (let i = 0; i < Math.max(keyA.length, keyB.length); i += 1) {
    const left = keyA[i];
    const right = keyB[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === 'string' || typeof right === 'string') {
      const cmp = String(left).localeCompare(String(right), 'en', { numeric: true });
      if (cmp) return cmp;
    } else if (left !== right) {
      return left - right;
    }
  }
  return (a.created_at || 0) - (b.created_at || 0);
}

function buildCategorySelectRow(customId, categories = proxyCategories.list()) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Which section is this for?')
    .addOptions(categories.slice(0, 25).map((category) => ({ label: category.label, value: category.key })));
  return new ActionRowBuilder().addComponents(select);
}

// A channel name for the request, prefilled from its title exactly like the
// one staff confirm when they accept it.
function buildChannelNameModal(customId, suggestion) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Channel name')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('chname')
          .setLabel('Name of the request channel')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(90)
          .setPlaceholder(suggestion)
          .setValue(String(suggestion || '').slice(0, 90))
      )
    );
}

// Modals cannot hold buttons, so the "hide it publicly" choice is a small
// yes/no field right under the username instead of a separate step.
function parseYesNo(value, fallback = false) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  return ['y', 'yes', 'true', '1', 'hide', 'hidden', 'private', 'ja'].includes(text);
}

function textInput(field, value) {
  const input = new TextInputBuilder()
    .setCustomId(field.key)
    .setLabel(field.label)
    .setStyle(field.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(Boolean(field.required))
    .setMaxLength(field.multiline ? 1000 : 300)
    .setPlaceholder(field.placeholder);
  if (value && String(value).trim()) input.setValue(String(value).trim().slice(0, field.multiline ? 1000 : 300));
  return new ActionRowBuilder().addComponents(input);
}

function buildInfoModal(customId, values = {}, category = null) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('General information');
  for (const field of infoFieldsForCategory(category)) modal.addComponents(textInput(field, values[field.key]));
  return modal;
}

function buildPriceModal(customId, values = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Best offer');
  const co = new TextInputBuilder()
    .setCustomId('co').setLabel('Best offer so far (USD)').setStyle(TextInputStyle.Short)
    .setRequired(false).setMaxLength(64).setPlaceholder('blank resets it to no offer yet');
  if (values.co && values.co !== 'Offer') co.setValue(String(values.co).slice(0, 64));
  modal.addComponents(new ActionRowBuilder().addComponents(co));
  return modal;
}

// One select row per registry page (Discord caps selects at 25 options).
function buildCapeSelectRows(customIdBase, selectedKeys = []) {
  const pages = capes.capeSelectPages(selectedKeys);
  return pages.map((page) => {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${customIdBase}:${page.index}`)
      .setPlaceholder(
        pages.length > 1
          ? `Add or remove capes (page ${page.index + 1}/${pages.length})`
          : 'Add or remove capes'
      )
      .setMinValues(0)
      .setMaxValues(page.options.length)
      .addOptions(page.options);
    return new ActionRowBuilder().addComponents(select);
  });
}

function buildEditSelectRow(listingId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rv:editsel:${listingId}`)
    .setPlaceholder('What do you want to edit?')
    .addOptions(
      { label: 'Title, kind, description, budget, amount', value: 'basics', emoji: '📄' },
      { label: 'Requirements', value: 'info', emoji: '📝' },
      { label: 'Best offer', value: 'prices', emoji: '💶' },
      { label: 'Wanted capes', value: 'capes', emoji: '🧥' }
    );
  return new ActionRowBuilder().addComponents(select);
}

function buildSoldButtonRow(listingId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ls:sold:${listingId}`).setLabel('Mark Fulfilled').setStyle(ButtonStyle.Danger)
  );
}

// Lets a buyer bid again from inside their own ticket, without going back to the
// public card. Lives here (not in buyFlow) so the outbid notice can use it too
// without listings depending on the interaction layer.
function buildOfferAgainRow(listingId, label = 'Offer another account') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ls:again:${listingId}`).setLabel(label).setStyle(ButtonStyle.Primary).setEmoji('💰')
  );
}

// mode: 'preview' (ticket, with accept/edit/deny), 'published' (offer/bin), 'plain'
function buildListingContainer(listing, mode, { revealIgn = false } = {}) {
  // No accent colour: listing cards should not show a coloured vertical bar.
  const container = new ContainerBuilder();

  // Header: big IGN with the account head beside it, info as a plain
  // bullet list underneath (no field labels), capes as emoji only.
  const bullets = [];
  // The kind's own fields first, then anything the buyer added by hand.
  const shown = new Set();
  for (const field of infoFieldsForCategory(listing.category)) {
    shown.add(field.key);
    bullets.push(...fieldBullets(field, listing.info ? listing.info[field.key] : null));
  }
  for (const field of Object.values(FIELDS)) {
    if (shown.has(field.key)) continue;
    bullets.push(...fieldBullets(field, listing.info ? listing.info[field.key] : null));
  }
  if (listing.capes && listing.capes.length) {
    bullets.push(`- Wants ${listing.capes.map((key) => capes.capeEmoji(key)).join(' ')}`);
  }
  // Inside tickets staff see the real IGN, tagged so it is obvious the public
  // listing hides it.
  const headerName = revealIgn
    ? `${listing.ign}${listing.ign_hidden ? ' (Hidden)' : ''}`
    : displayIgn(listing);
  const headerTexts = [new TextDisplayBuilder().setContent(`# ${headerName}`)];
  const description = listing.info ? String(listing.info.description || '').trim() : '';
  if (description) {
    headerTexts.push(new TextDisplayBuilder().setContent(description.slice(0, 1000)));
  }
  const amount = displayAmount(listing);
  if (amount) bullets.unshift(`- Wants **${amount}**`);
  if (bullets.length) {
    headerTexts.push(new TextDisplayBuilder().setContent(bullets.join('\n').slice(0, 2000)));
  }
  // Section components need an accessory. Hidden listings intentionally have
  // none, so use a plain text display for them; other cards retain the player
  // head thumbnail without triggering the missing-accessory serialization bug.
  if (!hasAvatar(listing)) {
    container.addTextDisplayComponents(...headerTexts);
  } else {
    const section = new SectionBuilder()
      .addTextDisplayComponents(...headerTexts)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl(listing)));
    container.addSectionComponents(section);
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true)
  );
  // Offers live in tickets only, so the public card shows the price and nothing
  // about who offered what.
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`Paying: **${displayBudget(listing)}**`)
  );
  if (mode === 'sold' || !listing.hide_proxy_label) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(mode === 'sold' ? '**FULFILLED**' : '**WANTED**')
    );
  }

  if (mode === 'preview') {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Looking for | Buyer: <@${listing.requester_id}> | Category: ${(proxyCategories.resolve(listing.category) || {}).label || listing.category}`
      )
    );
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rv:accept:${listing.id}`).setLabel('Accept').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`rv:edit:${listing.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId(`rv:deny:${listing.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('⛔')
      )
    );
  } else if (mode === 'published') {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ls:offer:${listing.id}`).setLabel('Offer an account').setStyle(ButtonStyle.Primary).setEmoji('💰')
      )
    );
  }
  if (mode === 'ticket-published') {
    // Mark Sold plus an Edit control: staff can always edit here, and the
    // account owner can keep editing until the listing goes public.
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ls:sold:${listing.id}`).setLabel('Mark Fulfilled').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`rv:edit:${listing.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary).setEmoji('✏️')
      )
    );
  }
  return container;
}

// Standard Discord embed used when importing a legacy proxy. It keeps the
// transferred listing readable in clients that do not render Components V2.
function buildListingEmbed(listing, { imported = false } = {}) {
  const category = proxyCategories.resolve(listing.category);
  const embed = new EmbedBuilder()
    .setTitle(displayIgn(listing))
    .addFields(
      { name: 'Category', value: category ? category.label : listing.category, inline: true },
      { name: 'Paying', value: displayBudget(listing), inline: true },
    );
  if (hasAvatar(listing)) embed.setThumbnail(avatarUrl(listing));
  for (const field of infoFieldsForCategory(listing.category)) {
    const lines = fieldBullets(field, listing.info ? listing.info[field.key] : null);
    if (!lines.length) continue;
    embed.addFields({
      name: field.key === 'extra' ? 'Other requirements' : field.label,
      value: lines.join('\n').slice(0, 1024),
      inline: false,
    });
  }
  if (listing.capes && listing.capes.length) {
    embed.addFields({ name: 'Wanted capes', value: listing.capes.map((key) => capes.capeEmoji(key)).join(' '), inline: false });
  }
  if (imported) embed.setFooter({ text: 'Imported request' });
  return embed;
}

function listingPayload(listing, mode, { isEdit = false, revealIgn = false } = {}) {
  const payload = {
    components: [buildListingContainer(listing, mode, { revealIgn })],
    allowedMentions: { parse: [] },
  };
  if (!isEdit) payload.flags = MessageFlags.IsComponentsV2;
  return payload;
}

// Re-renders the preview message inside the proxy ticket.
async function renderPreview(client, listingRow) {
  const listing = db.parseListing(listingRow);
  if (!listing.ticket_channel_id || !listing.preview_message_id) return;
  try {
    const channel = await client.channels.fetch(listing.ticket_channel_id);
    const message = await channel.messages.fetch(listing.preview_message_id);
    // Pending listings keep the review controls; once accepted the card swaps
    // them for Mark Sold, and a sold listing just shows its SOLD state.
    const mode = listing.status === 'pending'
      ? 'preview'
      : listing.status === 'sold'
      ? 'sold'
      : 'ticket-published';
    await message.edit(listingPayload(listing, mode, { isEdit: true, revealIgn: true }));
  } catch (err) {
    // ticket message may have been deleted
  }
}

// Tells earlier bidders that their offer is no longer the highest, both by DM
// and in their own offer ticket. The new bidder is never named: buyer and
// seller must not be able to find each other and skip the proxy fee.
async function notifyOutbid(client, listingRow, newAmount, { excludeUserId = null } = {}) {
  const listing = db.parseListing(listingRow);
  if (!listing) return 0;
  const top = usdToNumber(newAmount);
  if (top === null) return 0;
  let notified = 0;
  for (const ticket of db.offerTicketsForListing(listing.id)) {
    if (String(ticket.creator_id) === String(excludeUserId)) continue;
    const theirs = usdToNumber(ticket.offer_amount);
    if (theirs === null || theirs >= top) continue;
    const text = `Your asking price of **${displayUsdPrice(ticket.offer_amount)}** on the request **${displayIgn(listing)}** was undercut.
`
      + `The buyer's best offer is now **${displayUsdPrice(newAmount)}**. Offer a better deal if you still want the sale.`;
    // In their ticket first, so there is a record even when DMs are closed.
    if (ticket.status === 'open' && ticket.channel_id) {
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel && typeof channel.send === 'function') {
        await channel.send({
          content: `<@${ticket.creator_id}>`,
          embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('You have been undercut').setDescription(text)],
          // One click to re-bid from the ticket they are already reading.
          components: listing.status === 'published' ? [buildOfferAgainRow(listing.id, 'Offer again')] : [],
          allowedMentions: { users: [ticket.creator_id] },
        }).catch(() => {});
      }
    }
    const user = await client.users.fetch(ticket.creator_id).catch(() => null);
    if (user) await user.send({ content: `🔔 ${text}` }).catch(() => {}); // closed DMs are fine
    notified += 1;
  }
  return notified;
}

// Posts a short price update line in the public listing channel, e.g.
// "Current offer: **$120**" or "Bin raised to **$300**".
async function announceListingUpdate(client, listingRow, text) {
  const listing = db.parseListing(listingRow);
  if (!listing || !listing.listing_channel_id) return false;
  const channel = await client.channels.fetch(listing.listing_channel_id).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return false;
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

// "set" the first time, then "raised"/"lowered" relative to the old price.
function priceChangeVerb(oldValue, newValue) {
  const before = usdToNumber(oldValue);
  const after = usdToNumber(newValue);
  if (before === null || after === null) return 'set';
  if (after > before) return 'raised';
  if (after < before) return 'lowered';
  return 'set';
}

// Clears Mark Sold controls left on older bot messages in a proxy ticket, so a
// sold listing cannot be "sold" twice from a stale button.
async function stripSoldButtons(client, listingRow) {
  const listing = db.parseListing(listingRow);
  if (!listing || !listing.ticket_channel_id) return 0;
  const channel = await client.channels.fetch(listing.ticket_channel_id).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== 'function') return 0;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return 0;
  let cleared = 0;
  for (const message of messages.values()) {
    if (!message.author.bot || message.author.id !== client.user.id) continue;
    if (message.id === listing.preview_message_id) continue; // handled by renderPreview
    const raw = JSON.stringify(message.components || []);
    if (!raw.includes(`ls:sold:${listing.id}`)) continue;
    // Components V2 messages must keep a components array, so those are skipped.
    if (message.flags && message.flags.has(MessageFlags.IsComponentsV2)) continue;
    await message.edit({ components: [] }).then(() => { cleared += 1; }).catch(() => {});
  }
  return cleared;
}

// Re-renders the published listing message, if it exists.
async function renderPublished(client, listingRow) {
  const listing = db.parseListing(listingRow);
  if (!listing.listing_channel_id || !listing.listing_message_id) return;
  try {
    const channel = await client.channels.fetch(listing.listing_channel_id);
    const message = await channel.messages.fetch(listing.listing_message_id);
    await message.edit(listingPayload(listing, listing.status === 'sold' ? 'sold' : 'published', { isEdit: true }));
  } catch (err) {
    // listing message may have been deleted
  }
}

module.exports = {
  hasAvatar, wantsCapes, buildBasicsModal, displayBudget,
  isBlankAnswer, cleanFieldValue, fieldBullets,
  extraFieldsForCategory, buildExtraFieldRow, buildPickedFieldsModal,
  buildCategorySelectRow, buildChannelNameModal,
  FIELDS, FIELD_SETS, infoFieldsForCategory, avatarUrl, displayIgn, normalizeUsdPrice, displayUsdPrice, usdToNumber, statSortValues, mineconYear, mineconChannelName,
  formatNameChanges, nameChangeCount, threeCharClass, listingSortKey, compareListings,
  buildInfoModal, buildPriceModal, parseYesNo, budgetInputValue, displayAmount,
  buildCapeSelectRows, buildEditSelectRow, buildSoldButtonRow, buildOfferAgainRow,
  buildListingContainer, buildListingEmbed, listingPayload, renderPreview, renderPublished, stripSoldButtons,
  announceListingUpdate, priceChangeVerb, notifyOutbid,
};
