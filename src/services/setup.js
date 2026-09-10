const {
  ChannelType, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const db = require('../db');
const config = require('../config');
const tickets = require('./tickets');
const vouches = require('./vouches');
const listings = require('./listings');
const proxyCategories = require('./proxyCategories');

const P = PermissionFlagsBits;

async function ensureRole(guild, name, settingKey, color) {
  const storedId = db.getSetting(settingKey);
  const stored = storedId ? await guild.roles.fetch(storedId).catch(() => null) : null;
  if (stored) return stored;
  const existing = guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    db.setSetting(settingKey, existing.id);
    return existing;
  }
  const role = await guild.roles.create({ name, colors: { primaryColor: color }, permissions: [] });
  db.setSetting(settingKey, role.id);
  return role;
}

async function findTextChannel(guild, id) {
  const channel = id ? await guild.channels.fetch(id).catch(() => null) : null;
  return channel && channel.type === ChannelType.GuildText ? channel : null;
}

async function resolveSelectedTextChannel(guild, { settingKey, name, createOptions, selectedId }) {
  let channel = selectedId && selectedId !== 'new' ? await findTextChannel(guild, selectedId) : null;
  if (!channel && selectedId !== 'new') {
    channel = await findTextChannel(guild, db.getSetting(settingKey));
  }
  if (!channel && selectedId !== 'new') {
    channel = guild.channels.cache.find(
      (candidate) => candidate.type === ChannelType.GuildText && candidate.name.toLowerCase() === name.toLowerCase()
    ) || null;
  }
  if (!channel) {
    if (selectedId !== 'new') throw new Error(`No existing #${name} channel was selected.`);
    channel = await guild.channels.create(createOptions);
  }
  db.setSetting(settingKey, channel.id);
  return channel;
}

function readOnlyOverwrites(guild, memberRole, customerRole) {
  return [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    tickets.botOverwrite(guild),
    { id: memberRole.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] },
    { id: customerRole.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] },
  ];
}

// Ensures the configured vouches channel actually lets the Client role post a
// vouch. Applied to existing channels too, since /setup keeps their overwrites
// and an older vouches channel may never have granted SendMessages.
async function ensureVouchPermissions(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const guild = channel.guild;
  const customerRoleId = db.getSetting('customer_role');
  const memberRoleId = db.getSetting('member_role');
  const customerRole = customerRoleId ? await guild.roles.fetch(customerRoleId).catch(() => null) : null;
  const memberRole = memberRoleId ? await guild.roles.fetch(memberRoleId).catch(() => null) : null;
  if (customerRole) {
    await channel.permissionOverwrites.edit(customerRole, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    }).catch((err) => console.error('Could not grant Client vouch permissions:', err.message));
  }
  if (memberRole) {
    await channel.permissionOverwrites.edit(memberRole, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
    }).catch(() => {});
  }
  return Boolean(customerRole);
}

function buildProxyPanel() {
  const embed = new EmbedBuilder()
    .setColor(config.EMBED_COLOR)
    .setTitle('Looking for an account?')
    .setDescription(
      'Post what you are searching for and let sellers come to you.\n\n' +
      'Pick a category, describe the account you want (or name an exact IGN), list your requirements and set your budget. ' +
      'Staff reviews every request before it goes on the board.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:proxy').setLabel('Create Request').setStyle(ButtonStyle.Primary).setEmoji('🔎')
  );
  return { embeds: [embed], components: [row] };
}

function buildVerificationMessage() {
  const embed = new EmbedBuilder()
    .setColor(config.EMBED_COLOR)
    .setTitle('Welcome - Verify to Continue')
    .setDescription(`${config.RULES_TEXT}\n\nReact with ${config.VERIFY_EMOJI} below to verify.`);
  return { content: '', embeds: [embed] };
}

function buildTicketPanel() {
  const embed = new EmbedBuilder()
    .setColor(config.EMBED_COLOR)
    .setTitle('Tickets')
    .setDescription(
      'Open a ticket and staff will get back to you.\n\n' +
      '🔎 **Request an Account** - post what you are looking for\n' +
      '💰 **Sell an Account** - offer an account to our buyers\n' +
      '❓ **Other** - anything else'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tp:proxy').setLabel('Request an Account').setStyle(ButtonStyle.Primary).setEmoji('🔎'),
    new ButtonBuilder().setCustomId('tp:buy').setLabel('Sell an Account').setStyle(ButtonStyle.Success).setEmoji('💰'),
    new ButtonBuilder().setCustomId('tp:other').setLabel('Other').setStyle(ButtonStyle.Secondary).setEmoji('❓')
  );
  return { embeds: [embed], components: [row] };
}

async function ensurePanelMessage(channel, settingKey, payload) {
  const storedId = db.getSetting(settingKey);
  const existing = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
  if (existing) return existing;
  const message = await channel.send(payload);
  db.setSetting(settingKey, message.id);
  return message;
}

// `skipVisibility` lets bulk callers refresh visibility once at the end instead
// of after every single listing.
async function ensureListingCategory(guild, categoryKey, { channels = null, skipVisibility = false } = {}) {
  const settingKey = `cat_listing_${categoryKey}`;
  const storedId = db.getSetting(settingKey);
  const stored = storedId
    ? (channels && channels.get(storedId)) || await guild.channels.fetch(storedId).catch(() => null)
    : null;
  if (stored && stored.type === ChannelType.GuildCategory) {
    if (!skipVisibility) await updateListingCategoryVisibility(guild, stored, channels);
    return stored;
  }
  const categoryInfo = proxyCategories.resolve(categoryKey);
  if (!categoryInfo) throw new Error(`Unknown proxy category: ${categoryKey}`);
  const wantedName = categoryInfo.label;
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === wantedName.toLowerCase()
  );
  if (existing) {
    db.setSetting(settingKey, existing.id);
    if (!skipVisibility) await updateListingCategoryVisibility(guild, existing, channels);
    return existing;
  }
  const category = await guild.channels.create({
    name: wantedName,
    type: ChannelType.GuildCategory,
    permissionOverwrites: readOnlyOverwritesByIds(guild),
  });
  db.setSetting(settingKey, category.id);
  if (!skipVisibility) await updateListingCategoryVisibility(guild, category, channels);
  return category;
}

// Proxy listing categories stay out of the channel list until they contain a
// listing. Administrators retain access through Discord's Administrator
// permission, while normal Member and Customer roles only see non-empty ones.
async function updateListingCategoryVisibility(guild, category, prefetched = null) {
  if (!category || category.type !== ChannelType.GuildCategory) return false;
  // Bulk callers pass the channel list in; refetching it per category turns a
  // few hundred listings into a few hundred full-guild REST calls.
  const channels = prefetched || await guild.channels.fetch();
  const hasListings = channels.some((channel) => channel.parentId === category.id);
  for (const settingKey of ['member_role', 'customer_role']) {
    const roleId = db.getSetting(settingKey);
    if (!roleId) continue;
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    await category.permissionOverwrites.edit(role, {
      ViewChannel: hasListings,
      ReadMessageHistory: hasListings,
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    }).catch((err) => console.error(`Could not update ${category.name} visibility:`, err.message));
  }
  return hasListings;
}

async function refreshListingCategoryVisibility(guild) {
  for (const categoryInfo of proxyCategories.list()) {
    const storedId = db.getSetting(`cat_listing_${categoryInfo.key}`);
    let category = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      category = guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === categoryInfo.label.toLowerCase()
      ) || null;
    }
    if (category) await updateListingCategoryVisibility(guild, category);
  }
}

// The account-category picker follows the order staff set in Discord's channel
// sidebar. Categories without a corresponding Discord category stay at the end
// in the bot's normal category order.
function proxyCategoriesInDiscordOrder(guild) {
  return proxyCategories.list()
    .map((categoryInfo, fallbackIndex) => {
      const storedId = db.getSetting(`cat_listing_${categoryInfo.key}`);
      let category = storedId ? guild.channels.cache.get(storedId) : null;
      if (!category || category.type !== ChannelType.GuildCategory) {
        category = guild.channels.cache.find(
          (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === categoryInfo.label.toLowerCase()
        ) || null;
      }
      const position = category && Number.isFinite(category.rawPosition)
        ? category.rawPosition
        : null;
      return { categoryInfo, fallbackIndex, position };
    })
    .sort((left, right) => {
      if (left.position === null && right.position === null) return left.fallbackIndex - right.fallbackIndex;
      if (left.position === null) return 1;
      if (right.position === null) return -1;
      return left.position - right.position || left.fallbackIndex - right.fallbackIndex;
    })
    .map(({ categoryInfo }) => categoryInfo);
}

async function renameListingCategory(guild, categoryInfo) {
  const storedId = db.getSetting(`cat_listing_${categoryInfo.key}`);
  let category = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  if ((!category || category.type !== ChannelType.GuildCategory) && categoryInfo.previousLabel) {
    category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === categoryInfo.previousLabel.toLowerCase()
    ) || null;
    if (category) db.setSetting(`cat_listing_${categoryInfo.key}`, category.id);
  }
  if (!category || category.type !== ChannelType.GuildCategory) return false;
  if (category.name !== categoryInfo.label) await category.setName(categoryInfo.label, 'Proxy category renamed by staff');
  await updateListingCategoryVisibility(guild, category);
  return true;
}

// Disablement removes a category from the bot's picker. Delete its Discord
// category as well only when it is empty; never delete unrelated channels.
async function removeListingCategory(guild, categoryInfo) {
  const settingKey = `cat_listing_${categoryInfo.key}`;
  const storedId = db.getSetting(settingKey);
  let category = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === categoryInfo.label.toLowerCase()
    ) || null;
  }
  if (!category) return { removed: false, reason: 'No matching Discord category was found.' };
  const channels = await guild.channels.fetch();
  const hasChildren = channels.some((channel) => channel.parentId === category.id);
  if (hasChildren) return { removed: false, reason: 'The Discord category still contains channels.' };
  await category.delete('Proxy category removed by staff');
  db.delSetting(settingKey);
  return { removed: true };
}

async function ensureSoldCategory(guild) {
  const storedId = db.getSetting('cat_sold');
  const stored = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  if (stored && stored.type === ChannelType.GuildCategory) return stored;
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === config.CAT_SOLD.toLowerCase()
  );
  if (existing) {
    db.setSetting('cat_sold', existing.id);
    return existing;
  }
  const category = await guild.channels.create({
    name: config.CAT_SOLD,
    type: ChannelType.GuildCategory,
    permissionOverwrites: readOnlyOverwritesByIds(guild),
  });
  db.setSetting('cat_sold', category.id);
  return category;
}

// `cache` lets a bulk run share one channel list and one set of resolved
// categories across every listing instead of refetching them each time.
async function organizeListing(guild, listingRow, { skipStatSort = false, cache = null, skipVisibility = false } = {}) {
  const listing = db.parseListing(listingRow);
  if (!listing) return { movedListing: false, movedTicket: false };
  let movedListing = false;
  let movedTicket = false;
  const channels = cache ? cache.channels : null;
  const getChannel = async (id) => (channels && channels.get(id)) || guild.channels.fetch(id).catch(() => null);
  const resolveCategory = async (key, loader) => {
    if (!cache) return loader();
    if (!cache.categories.has(key)) cache.categories.set(key, await loader());
    return cache.categories.get(key);
  };

  const baseListingCategory = listing.status === 'sold'
    ? await resolveCategory('__sold', () => ensureSoldCategory(guild))
    : await resolveCategory(listing.category, () => ensureListingCategory(guild, listing.category, { channels, skipVisibility }));
  // Categories cap at 50 channels, so move into an overflow sibling if needed.
  const listingCategory = await tickets.categoryWithSpace(guild, baseListingCategory, channels).catch(() => baseListingCategory);
  if (listing.listing_channel_id) {
    const channel = await getChannel(listing.listing_channel_id);
    const alreadyInFamily = tickets.inCategoryFamily(channel, baseListingCategory);
    if (channel && channel.type === ChannelType.GuildText && !alreadyInFamily) {
      await channel.setParent(listingCategory.id, { lockPermissions: false }).catch((err) => {
        console.error('Could not move listing channel:', err.message);
      });
      movedListing = true;
    }
  }
  if (listing.ticket_channel_id) {
    const ticketChannel = await getChannel(listing.ticket_channel_id);
    const baseTicketCategory = await resolveCategory('__proxyTickets', () => tickets.ensureCategory(guild, 'proxy'));
    const proxyTicketCategory = await tickets.categoryWithSpace(guild, baseTicketCategory, channels).catch(() => baseTicketCategory);
    const alreadyInFamily = tickets.inCategoryFamily(ticketChannel, baseTicketCategory);
    if (ticketChannel && ticketChannel.type === ChannelType.GuildText && !alreadyInFamily) {
      await ticketChannel.setParent(proxyTicketCategory.id, { lockPermissions: false }).catch((err) => {
        console.error('Could not move proxy ticket:', err.message);
      });
      movedTicket = true;
    }
  }
  // Keep the account category ordered by its own rules after every change.
  if (!skipStatSort && listing.status !== 'sold') {
    await sortListingChannels(guild, listing.category, listingCategory, channels).catch(() => {});
  }
  // Bulk runs refresh visibility once at the end rather than per listing.
  if (!skipVisibility) await refreshListingCategoryVisibility(guild);
  return { movedListing, movedTicket };
}

// Sorts the managed listing channels of one account category using that
// category's rules (see listings.listingSortKey): Minecon by year then name
// changes, OG/Semi by name length, 3CN digits before letters, Stats by
// stars/FKDR, everything else by price. Unmanaged channels are left alone.
async function sortListingChannels(guild, categoryKey, categoryChannel = null, prefetched = null) {
  const category = categoryChannel
    || await ensureListingCategory(guild, categoryKey, { channels: prefetched, skipVisibility: true }).catch(() => null);
  if (!category) return 0;
  const entries = [];
  for (const row of db.listingsForOrganization()) {
    const listing = db.parseListing(row);
    if (listing.category !== categoryKey || listing.status === 'sold' || !listing.listing_channel_id) continue;
    const channel = (prefetched && prefetched.get(listing.listing_channel_id))
      || await guild.channels.fetch(listing.listing_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    // Include overflow siblings so the whole family sorts as one list.
    if (!tickets.inCategoryFamily(channel, category)) continue;
    entries.push({ channel, listing });
  }
  if (entries.length < 2) return 0;
  entries.sort((a, b) => listings.compareListings(a.listing, b.listing));
  await guild.channels.setPositions(
    entries.map((entry, position) => ({ channel: entry.channel.id, position }))
  ).catch((err) => console.error(`Could not sort ${categoryKey} listing channels:`, err.message));
  return entries.length;
}

// Kept for callers that only want the Stats category refreshed.
async function sortStatListingChannels(guild, statCategory = null) {
  return sortListingChannels(guild, 'mcacc', statCategory);
}

async function sortAllListingChannels(guild, prefetched = null) {
  const channels = prefetched || await guild.channels.fetch();
  let sorted = 0;
  for (const categoryInfo of proxyCategories.list()) {
    sorted += await sortListingChannels(guild, categoryInfo.key, null, channels).catch(() => 0);
  }
  return sorted;
}

// Keeps overflow categories directly under the category they belong to
// ("OG 2" right below "OG"). Your own category order is never touched: only a
// sibling that has drifted away from its base is moved.
async function arrangeListingCategories(guild, prefetched = null) {
  const channels = prefetched || await guild.channels.fetch();
  const isCategory = (channel) => channel && channel.type === ChannelType.GuildCategory;
  const categories = [...channels.values()].filter(isCategory);

  // Group categories by their base name: "OG" -> ["OG", "OG 2", "OG 3"].
  const families = new Map();
  for (const channel of categories) {
    const base = channel.name.replace(/\s+\d+$/, '').toLowerCase();
    if (!families.has(base)) families.set(base, []);
    families.get(base).push(channel);
  }

  const moves = [];
  for (const group of families.values()) {
    if (group.length < 2) continue; // nothing to tuck under anything
    group.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    const [base, ...overflows] = group;
    let expected = base.rawPosition;
    for (const overflow of overflows) {
      expected += 1;
      if (overflow.rawPosition !== expected) {
        moves.push({ channel: overflow.id, position: expected });
      }
    }
  }
  if (!moves.length) return 0;
  try {
    await guild.channels.setPositions(moves);
    return moves.length;
  } catch (err) {
    console.error('Could not place overflow categories:', err.message);
    return 0;
  }
}

async function organizeAllListings(guild, { onProgress = null } = {}) {
  let listingMoves = 0;
  let ticketMoves = 0;
  const rows = db.listingsForOrganization();
  // One channel list and one set of resolved categories for the whole run.
  const cache = { channels: await guild.channels.fetch(), categories: new Map() };
  let index = 0;
  for (const row of rows) {
    index += 1;
    const result = await organizeListing(guild, row, { skipStatSort: true, cache, skipVisibility: true });
    if (result.movedListing) listingMoves += 1;
    if (result.movedTicket) ticketMoves += 1;
    if (onProgress) await onProgress({ phase: 'moving channels', done: index, total: rows.length });
  }
  if (onProgress) await onProgress({ phase: 'sorting categories', done: rows.length, total: rows.length });
  const sorted = await sortAllListingChannels(guild, cache.channels);
  await refreshListingCategoryVisibility(guild);
  if (onProgress) await onProgress({ phase: 'placing overflow categories', done: rows.length, total: rows.length });
  const arranged = await arrangeListingCategories(guild);
  return { listingMoves, ticketMoves, arranged, sorted };
}

function readOnlyOverwritesByIds(guild) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    tickets.botOverwrite(guild),
  ];
  for (const key of ['member_role', 'customer_role']) {
    const roleId = db.getSetting(key);
    const role = roleId ? guild.roles.cache.get(roleId) : null;
    if (role) {
      overwrites.push({
        id: role.id,
        allow: [P.ViewChannel, P.ReadMessageHistory],
        deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads],
      });
    }
  }
  return overwrites;
}

// The Discord category the community channels live in. An existing category
// with the same name is adopted rather than duplicated.
async function ensureGeneralCategory(guild) {
  const storedId = db.getSetting('cat_general');
  const stored = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  if (stored && stored.type === ChannelType.GuildCategory) return stored;
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory
      && channel.name.toLowerCase() === config.CAT_GENERAL.toLowerCase()
  );
  if (existing) {
    db.setSetting('cat_general', existing.id);
    return existing;
  }
  const category = await guild.channels.create({
    name: config.CAT_GENERAL,
    type: ChannelType.GuildCategory,
    permissionOverwrites: readOnlyOverwritesByIds(guild),
  }).catch((err) => {
    console.error('Could not create the General category:', err.message);
    return null;
  });
  if (category) db.setSetting('cat_general', category.id);
  return category;
}

// The plain community channels from config.EXTRA_CHANNELS (chat, botspam,
// announcements, partners, telegram, giveaways, dndw). An existing channel with
// the same name is adopted untouched; only new ones get the preset's perms.
async function ensureExtraChannels(guild) {
  const channelPerms = require('./channelPerms');
  const created = [];
  const kept = [];
  const parent = await ensureGeneralCategory(guild);
  for (const entry of config.EXTRA_CHANNELS) {
    const settingKey = `extra_channel_${entry.name}`;
    const storedId = db.getSetting(settingKey);
    let channel = storedId ? await findTextChannel(guild, storedId) : null;
    if (!channel) {
      channel = guild.channels.cache.find(
        (candidate) => candidate.type === ChannelType.GuildText
          && candidate.name.toLowerCase() === entry.name.toLowerCase()
      ) || null;
      if (channel) kept.push(channel);
    }
    if (!channel) {
      channel = await guild.channels.create({
        name: entry.name,
        type: ChannelType.GuildText,
        parent: parent ? parent.id : undefined,
        permissionOverwrites: await channelPerms.overwritesFor(guild, entry.preset),
      }).catch((err) => {
        console.error(`Could not create #${entry.name}:`, err.message);
        return null;
      });
      if (channel) created.push(channel);
    }
    // An adopted channel keeps whatever category it already sits in; only a
    // homeless one is tucked under General.
    if (channel && parent && !channel.parentId) {
      await channel.setParent(parent.id, { lockPermissions: false })
        .catch((err) => console.error(`Could not move #${entry.name} into General:`, err.message));
    }
    if (channel) db.setSetting(settingKey, channel.id);
  }
  return { created, kept, parent };
}

// `choices` comes from the guided /setup flow. Existing selected channels keep
// their current names and permission overwrites; only newly created channels
// receive the bot's default permission template.
async function runSetup(guild, choices) {
  const summary = [];
  const memberRole = await ensureRole(guild, config.ROLE_MEMBER, 'member_role', 0x57f287);
  const customerRole = await ensureRole(guild, config.ROLE_CUSTOMER, 'customer_role', 0xfee75c);
  summary.push(`Roles ready: ${memberRole} ${customerRole}`);
  // Without STAFF_ROLE_ID in .env only admins count as staff, so make the role
  // and tell the owner which ID to paste in.
  if (!config.STAFF_ROLE_ID) {
    const staffRole = await ensureRole(guild, config.ROLE_STAFF, 'staff_role', 0x5865f2);
    summary.push(`No STAFF_ROLE_ID is configured. Put \`STAFF_ROLE_ID=${staffRole.id}\` in .env and restart to let ${staffRole} review requests.`);
  }

  const verifyChannel = await resolveSelectedTextChannel(guild, {
    settingKey: 'verify_channel', name: config.CH_VERIFY, selectedId: choices.verify,
    createOptions: {
      name: config.CH_VERIFY, type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads] },
        tickets.botOverwrite(guild),
        { id: memberRole.id, deny: [P.ViewChannel] },
      ],
    },
  });
  const verifyId = db.getSetting('verify_message');
  let verifyMessage = verifyId ? await verifyChannel.messages.fetch(verifyId).catch(() => null) : null;
  if (!verifyMessage) {
    verifyMessage = await verifyChannel.send(buildVerificationMessage());
    db.setSetting('verify_message', verifyMessage.id);
  } else {
    await verifyMessage.edit(buildVerificationMessage()).catch(() => {});
  }
  await verifyMessage.react(config.VERIFY_EMOJI).catch(() => {});
  summary.push(`Verification uses ${verifyChannel}`);

  const ticketsChannel = await resolveSelectedTextChannel(guild, {
    settingKey: 'tickets_channel', name: config.CH_TICKETS, selectedId: choices.tickets,
    createOptions: { name: config.CH_TICKETS, type: ChannelType.GuildText, permissionOverwrites: readOnlyOverwrites(guild, memberRole, customerRole) },
  });
  await ensurePanelMessage(ticketsChannel, 'panel_ticket_message', buildTicketPanel());

  const proxyChannel = await resolveSelectedTextChannel(guild, {
    settingKey: 'proxy_channel', name: config.CH_PROXY, selectedId: choices.proxy,
    createOptions: { name: config.CH_PROXY, type: ChannelType.GuildText, permissionOverwrites: readOnlyOverwrites(guild, memberRole, customerRole) },
  });
  await ensurePanelMessage(proxyChannel, 'panel_proxy_message', buildProxyPanel());
  summary.push(`Panels use ${ticketsChannel} and ${proxyChannel}`);

  const extra = await ensureExtraChannels(guild);
  if (extra.created.length || extra.kept.length) {
    summary.push(
      `Community channels${extra.parent ? ` under **${extra.parent.name}**` : ''}: ${[...extra.created, ...extra.kept].map((channel) => `${channel}`).join(' ')}`
      + `${extra.kept.length ? ` (${extra.kept.length} already existed and were left untouched)` : ''}.`
    );
  }

  await tickets.ensureCategory(guild, 'proxy');
  await tickets.ensureCategory(guild, 'buy');
  await tickets.ensureCategory(guild, 'support');
  for (const category of proxyCategories.list()) await ensureListingCategory(guild, category.key);
  await refreshListingCategoryVisibility(guild);
  await ensureSoldCategory(guild);
  const arranged = await arrangeListingCategories(guild);
  summary.push(`Ticket and listing categories are ready (existing matching categories were kept)${arranged ? `, and ${arranged} overflow category/categories were placed under their originals` : ''}.`);

  const vouchChannel = await resolveSelectedTextChannel(guild, {
    settingKey: 'vouch_channel', name: config.CH_VOUCHES_PREFIX, selectedId: choices.vouches,
    createOptions: {
      name: `${config.CH_VOUCHES_PREFIX}-0`, type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        tickets.botOverwrite(guild),
        { id: memberRole.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
        { id: customerRole.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages], deny: [P.CreatePublicThreads, P.CreatePrivateThreads] },
      ],
    },
  });
  // Optional log channels. 'skip' leaves each of them untouched.
  const logs = require('./logs');
  const optionalLogs = [
    { choice: choices.log, kind: 'audit', defaultName: 'bot-logs', label: 'Staff audit logs' },
    { choice: choices.msglog, kind: 'messages', defaultName: 'message-log', label: 'Edited and deleted messages' },
    { choice: choices.transcript, kind: 'transcripts', defaultName: 'transcripts', label: 'Ticket transcripts' },
  ];
  for (const entry of optionalLogs) {
    if (!entry.choice || entry.choice === 'skip') continue;
    if (entry.choice === 'new') {
      const { channel: made, created } = await logs.ensureLogChannel(guild, entry.defaultName, entry.kind);
      summary.push(`${created ? 'Created' : 'Reusing'} ${made} for ${entry.label.toLowerCase()}.`);
    } else {
      const picked = await findTextChannel(guild, entry.choice);
      if (picked) {
        db.setSetting(logs.CHANNEL_SETTINGS[entry.kind], picked.id);
        summary.push(`${entry.label} go to ${picked}.`);
      }
    }
  }

  await ensureVouchPermissions(vouchChannel);
  const vouchCount = await vouches.recountHistory(vouchChannel);
  summary.push(`Vouches use ${vouchChannel}; counted ${vouchCount} existing vouch(es). The Client role can post vouches there.`);
  summary.push('No channels, categories, roles, messages, or permission overwrites outside your selections were deleted or changed.');
  return summary;
}

module.exports = {
  runSetup, ensureExtraChannels, ensureGeneralCategory, ensureVouchPermissions, arrangeListingCategories, buildProxyPanel, buildTicketPanel, buildVerificationMessage, ensureListingCategory, removeListingCategory, ensureSoldCategory,
  renameListingCategory, updateListingCategoryVisibility, refreshListingCategoryVisibility,
  proxyCategoriesInDiscordOrder,
  organizeListing, organizeAllListings, sortStatListingChannels, sortListingChannels, sortAllListingChannels,
};
