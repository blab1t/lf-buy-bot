const {
  MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ChannelType,
} = require('discord.js');
const db = require('../db');
const state = require('../util/state');
const setup = require('../services/setup');
const proxyCategories = require('../services/proxyCategories');
const logs = require('../services/logs');
const { requireAdmin } = require('../util/perms');

const EPH = MessageFlags.Ephemeral;
const STEPS = [
  { key: 'verify', label: 'verification / rules', hint: 'Choose the existing text channel where the rules and verification message should live.', defaultName: 'verify' },
  { key: 'tickets', label: 'ticket panel', hint: 'Choose the existing text channel where the Buy / Proxy / Other panel should be posted.', defaultName: 'tickets' },
  { key: 'proxy', label: 'proxy panel', hint: 'Choose the existing text channel where the Create Proxy panel should be posted.', defaultName: 'proxy' },
  { key: 'vouches', label: 'vouches', hint: 'Choose the existing vouches text channel. The bot will count its existing valid vouch messages and rename it to vouches-COUNT.', defaultName: 'vouches' },
  { key: 'log', label: 'staff audit log', hint: 'Choose (or create) a private channel where the bot logs listing, ticket and offer events. This one is optional.', defaultName: 'bot-logs', optional: true },
  { key: 'msglog', label: 'message log', hint: 'Choose (or create) a private channel where edited and deleted messages are recorded. Optional.', defaultName: 'message-log', optional: true },
  { key: 'transcript', label: 'ticket transcripts', hint: 'Choose (or create) a private channel where ticket transcripts are archived when a ticket closes. Optional.', defaultName: 'transcripts', optional: true },
];

// Wizard step keys map onto their settings keys.
const STEP_SETTING_KEYS = { log: 'log_channel', msglog: 'msglog_channel', transcript: 'transcript_channel' };

const TICKET_CATEGORY_KEYS = { proxy: 'cat_proxy', buy: 'cat_buy', support: 'cat_support' };

function dataFor(userId) {
  const data = state.get(userId);
  return data && data.kind === 'setup' ? data : null;
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('su:hub:x').setLabel('Back to setup menu').setStyle(ButtonStyle.Secondary).setEmoji('◀️')
  );
}

// ---------------------------------------------------------------- hub

function hubPayload() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('su:menu:x')
    .setPlaceholder('What do you want to configure?')
    .addOptions(
      { label: 'Channels', value: 'channels', description: 'Verify, ticket panel, proxy panel, vouches, log channel', emoji: '💬' },
      { label: 'Roles', value: 'roles', description: 'Verified Member role and Client/Customer role', emoji: '🎭' },
      { label: 'Ticket categories', value: 'tickets', description: 'Where proxy / buy / support tickets are created', emoji: '🎟️' },
      { label: 'Proxy categories', value: 'pcats', description: 'Enable or disable OG, Semi, Stats, Minecon, ...', emoji: '🏷️' },
      { label: 'Listing categories', value: 'lcats', description: 'Which Discord category each proxy category uses', emoji: '📂' },
      { label: 'Sold category', value: 'sold', description: 'Where sold listings are moved', emoji: '💰' },
    );
  return {
    content: '**Setup**\nPick a section to configure. Everything here is optional and can be changed later.',
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

// ---------------------------------------------------------------- roles

async function rolesPayload(guild) {
  const memberId = db.getSetting('member_role');
  const customerId = db.getSetting('customer_role');
  return {
    content: [
      '**Roles**',
      `Verified Member role: ${memberId ? `<@&${memberId}>` : '_not set_'}`,
      `Client / Customer role: ${customerId ? `<@&${customerId}>` : '_not set_'}`,
      '',
      'Pick existing roles below. Leave a picker untouched to keep the current role.',
    ].join('\n'),
    components: [
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('su:role:member').setPlaceholder('Verified Member role').setMinValues(1).setMaxValues(1)
      ),
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('su:role:customer').setPlaceholder('Client / Customer role').setMinValues(1).setMaxValues(1)
      ),
      backRow().components[0] ? backRow() : null,
    ].filter(Boolean),
    allowedMentions: { parse: [] },
  };
}

// ------------------------------------------------------- ticket categories

function ticketCategoriesPayload() {
  const rows = ['proxy', 'buy', 'support'].map((type) => new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`su:tcat:${type}`)
      .setPlaceholder(`${type} tickets category`)
      .setChannelTypes(ChannelType.GuildCategory)
      .setMinValues(1)
      .setMaxValues(1)
  ));
  const current = ['proxy', 'buy', 'support']
    .map((type) => {
      const id = db.getSetting(TICKET_CATEGORY_KEYS[type]);
      return `${type}: ${id ? `<#${id}>` : '_not set_'}`;
    })
    .join('\n');
  return {
    content: `**Ticket categories**\nWhere new tickets are created.\n${current}`,
    components: [...rows, backRow()],
    allowedMentions: { parse: [] },
  };
}

function soldPayload() {
  const id = db.getSetting('cat_sold');
  return {
    content: `**Sold category**\nSold listings are moved here.\nCurrent: ${id ? `<#${id}>` : '_not set_'}`,
    components: [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('su:tcat:sold').setPlaceholder('Sold listings category')
          .setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1)
      ),
      backRow(),
    ],
    allowedMentions: { parse: [] },
  };
}

// -------------------------------------------------------- proxy categories

function proxyCategoriesPayload() {
  const active = proxyCategories.list();
  const activeKeys = new Set(active.map((c) => c.key));
  // Built-ins can be toggled; disabled ones are still offered so they can return.
  const all = [...active];
  for (const key of require('../config').PROXY_CATEGORIES) {
    if (!activeKeys.has(key)) all.push({ key, label: require('../config').CATEGORY_LABELS[key] || key });
  }
  const options = all.slice(0, 25).map((c) => ({
    label: c.label.slice(0, 100),
    value: c.key,
    default: activeKeys.has(c.key),
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId('su:pcats:x')
    .setPlaceholder('Select every proxy category that should be enabled')
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);
  return {
    content: [
      '**Proxy categories**',
      `Enabled: ${active.map((c) => `**${c.label}**`).join(', ') || '_none_'}`,
      '',
      'Select the ones that should be enabled (deselect to disable). A category with listings cannot be disabled.',
      'Add custom ones with `/proxy category-create`.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(menu), backRow()],
  };
}

// ------------------------------------------------------ listing categories

function listingCategoriesPayload(selectedKey = null) {
  const cats = proxyCategories.list().slice(0, 25);
  const picker = new StringSelectMenuBuilder()
    .setCustomId('su:lcatpick:x')
    .setPlaceholder('Pick a proxy category')
    .addOptions(cats.map((c) => ({
      label: c.label.slice(0, 100),
      value: c.key,
      default: c.key === selectedKey,
      description: (() => {
        const id = db.getSetting(`cat_listing_${c.key}`);
        return id ? 'Discord category set' : 'not set';
      })(),
    })));
  const rows = [new ActionRowBuilder().addComponents(picker)];
  if (selectedKey) {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`su:lcat:${selectedKey}`)
        .setPlaceholder(`Discord category for ${selectedKey}`)
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1)
    ));
  }
  rows.push(backRow());
  const currentId = selectedKey ? db.getSetting(`cat_listing_${selectedKey}`) : null;
  return {
    content: [
      '**Listing categories**',
      'Which Discord category holds the listing channels of each proxy category.',
      selectedKey ? `\nSelected: **${selectedKey}** - current: ${currentId ? `<#${currentId}>` : '_not set_'}` : '',
    ].join('\n'),
    components: rows,
    allowedMentions: { parse: [] },
  };
}

// ------------------------------------------------------- guided channels

async function stepPayload(guild, data) {
  const step = STEPS[data.index];
  const settingKey = `${step.key}_channel`;
  const currentId = STEP_SETTING_KEYS[step.key] ? db.getSetting(STEP_SETTING_KEYS[step.key]) : db.getSetting(settingKey);
  const current = currentId ? await guild.channels.fetch(currentId).catch(() => null) : null;
  const content = [
    `**Channels ${data.index + 1}/${STEPS.length}: ${step.label}**`,
    step.hint,
    current ? `Current saved channel: ${current}` : `No channel is saved yet (suggested name: #${step.defaultName}).`,
    '',
    'Use the channel picker to select an existing channel, keep the current saved channel, or explicitly create a new one.',
  ].join('\n');
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(`su:pick:${step.key}`)
    .setPlaceholder(`Select an existing #${step.defaultName} channel`)
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  const buttons = new ActionRowBuilder().addComponents(
    ...[
      new ButtonBuilder().setCustomId(`su:new:${step.key}`).setLabel(`Create #${step.defaultName}`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`su:keep:${step.key}`).setLabel('Use current saved channel').setStyle(ButtonStyle.Secondary).setDisabled(!current),
      ...(step.optional ? [new ButtonBuilder().setCustomId(`su:skip:${step.key}`).setLabel('Skip').setStyle(ButtonStyle.Secondary)] : []),
    ],
  );
  return { content, components: [new ActionRowBuilder().addComponents(picker), buttons] };
}

async function start(interaction) {
  if (!(await requireAdmin(interaction))) return;
  state.clear(interaction.user.id);
  return interaction.reply({ ...hubPayload(), flags: EPH });
}

async function advance(interaction, selectedId) {
  const data = dataFor(interaction.user.id);
  const step = data && STEPS[data.index];
  if (!data || !step) {
    return interaction.reply({ content: 'This setup session expired. Run /setup again.', flags: EPH });
  }
  data.choices[step.key] = selectedId;
  data.index += 1;
  if (data.index < STEPS.length) return interaction.update(await stepPayload(interaction.guild, data));

  await interaction.update({ content: 'Applying your selected channels...', components: [] });
  try {
    const summary = await setup.runSetup(interaction.guild, data.choices);
    state.clear(interaction.user.id);
    return interaction.editReply({ content: `Setup complete.\n${summary.join('\n')}` });
  } catch (err) {
    console.error('Setup flow failed:', err);
    return interaction.editReply({ content: `Setup could not finish: ${err.message}\nNo unselected server channels were changed.` });
  }
}

// ---------------------------------------------------------------- router

async function handle(interaction, parts) {
  if (!(await requireAdmin(interaction))) return;
  const action = parts[1];
  const key = parts[2];

  if (action === 'hub') {
    state.clear(interaction.user.id);
    return interaction.update(hubPayload());
  }

  if (action === 'menu') {
    const choice = interaction.values[0];
    if (choice === 'channels') {
      const data = { kind: 'setup', index: 0, choices: {} };
      state.set(interaction.user.id, data);
      return interaction.update(await stepPayload(interaction.guild, data));
    }
    if (choice === 'roles') return interaction.update(await rolesPayload(interaction.guild));
    if (choice === 'tickets') return interaction.update(ticketCategoriesPayload());
    if (choice === 'sold') return interaction.update(soldPayload());
    if (choice === 'pcats') return interaction.update(proxyCategoriesPayload());
    if (choice === 'lcats') return interaction.update(listingCategoriesPayload());
    return null;
  }

  if (action === 'role') {
    const roleId = interaction.values[0];
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) return interaction.reply({ content: 'That role no longer exists.', flags: EPH });
    if (role.managed) return interaction.reply({ content: 'That role is managed by an integration and cannot be used.', flags: EPH });
    db.setSetting(key === 'member' ? 'member_role' : 'customer_role', role.id);
    await interaction.update(await rolesPayload(interaction.guild));
    return interaction.followUp({
      content: `${key === 'member' ? 'Verified Member' : 'Client'} role set to ${role}.${role.editable ? '' : ' ⚠️ Move my role above it so I can assign it.'}`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  }

  if (action === 'tcat') {
    const channelId = interaction.values[0];
    const category = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.reply({ content: 'Pick a category channel.', flags: EPH });
    }
    if (key === 'sold') {
      db.setSetting('cat_sold', category.id);
      return interaction.update(soldPayload());
    }
    db.setSetting(TICKET_CATEGORY_KEYS[key], category.id);
    return interaction.update(ticketCategoriesPayload());
  }

  if (action === 'lcatpick') return interaction.update(listingCategoriesPayload(interaction.values[0]));

  if (action === 'lcat') {
    const category = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.reply({ content: 'Pick a category channel.', flags: EPH });
    }
    db.setSetting(`cat_listing_${key}`, category.id);
    await setup.updateListingCategoryVisibility(interaction.guild, category).catch(() => {});
    return interaction.update(listingCategoriesPayload(key));
  }

  if (action === 'pcats') {
    const wanted = new Set(interaction.values);
    const active = proxyCategories.list().map((c) => c.key);
    const notes = [];
    for (const cat of proxyCategories.list()) {
      if (!wanted.has(cat.key)) {
        try {
          proxyCategories.remove(cat.key);
          notes.push(`disabled **${cat.label}**`);
        } catch (err) {
          notes.push(`could not disable **${cat.label}**: ${err.message}`);
        }
      }
    }
    for (const value of wanted) {
      if (active.includes(value)) continue;
      const label = require('../config').CATEGORY_LABELS[value] || value;
      try {
        const created = proxyCategories.create(label);
        await setup.ensureListingCategory(interaction.guild, created.key).catch(() => {});
        notes.push(`enabled **${created.label}**`);
      } catch (err) {
        notes.push(`could not enable **${label}**: ${err.message}`);
      }
    }
    await interaction.update(proxyCategoriesPayload());
    if (notes.length) {
      return interaction.followUp({ content: notes.join('\n').slice(0, 1900), flags: EPH });
    }
    return null;
  }

  // guided channel steps
  const data = dataFor(interaction.user.id);
  const step = data && STEPS[data.index];
  if (!step || step.key !== key) {
    return interaction.reply({ content: 'This setup session is no longer active. Run /setup again.', flags: EPH });
  }
  if (action === 'pick') return advance(interaction, interaction.values[0]);
  if (action === 'new') return advance(interaction, 'new');
  if (action === 'skip') return advance(interaction, 'skip');
  if (action === 'keep') {
    const id = STEP_SETTING_KEYS[key] ? db.getSetting(STEP_SETTING_KEYS[key]) : db.getSetting(`${key}_channel`);
    if (!id) return interaction.reply({ content: 'There is no saved channel to use. Choose a channel or create one.', flags: EPH });
    return advance(interaction, id);
  }
  return null;
}

module.exports = { start, handle };
