const {
  Client, GatewayIntentBits, Partials, Events, MessageFlags, OverwriteType,
} = require('discord.js');
const config = require('./config');
const db = require('./db');
const definitions = require('./commands/definitions');
const commands = require('./commands/handlers');
const proxyWizard = require('./interactions/proxyWizard');
const proxyReview = require('./interactions/proxyReview');
const buyFlow = require('./interactions/buyFlow');
const ticketFlow = require('./interactions/ticketFlow');
const setupFlow = require('./interactions/setupFlow');
const capes = require('./services/capes');
const autodelete = require('./services/autodelete');
const tickets = require('./services/tickets');
const vouches = require('./services/vouches');
const giveaways = require('./services/giveaways');
const invites = require('./services/invites');
const pingRoles = require('./services/pingRoles');
const sync = require('./services/sync');
const linkfilter = require('./services/linkfilter');
const logs = require('./services/logs');
const { buildCryptoMessage } = require('./services/crypto');
const { isAdmin, requireAdmin } = require('./util/perms');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// DM-capable commands are registered globally (as a user-installable app);
// everything else stays a fast, guild-scoped command in the configured server.
const guildDefinitions = definitions.filter((d) => !definitions.DM_COMMANDS.has(d.name));
const globalDefinitions = definitions.filter((d) => definitions.DM_COMMANDS.has(d.name));
// Fallback when global (user-install) registration is unavailable, e.g. the app
// has not enabled User Install yet: register everything as guild commands so the
// DM-capable commands still work inside the server (just not in DMs).
const guildFallbackDefinitions = definitions.map((d) => {
  const { integration_types, contexts, ...rest } = d;
  return rest;
});

async function initGuild(guild) {
  try {
    await guild.commands.set(guildDefinitions);
  } catch (err) {
    console.error('Command registration failed:', err.message);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Register the user-installable commands globally. If that fails (User Install
  // not enabled for the app), fall back to registering them per-guild instead.
  let globalOk = false;
  try {
    await client.application.commands.set(globalDefinitions);
    globalOk = true;
    console.log(`Registered ${globalDefinitions.length} global user-installable command(s): ${globalDefinitions.map((d) => d.name).join(', ')}.`);
  } catch (err) {
    console.error('Global command registration failed (enable User Install in the Developer Portal to use commands in DMs):', err.message);
  }
  const guild = await client.guilds.fetch(config.GUILD_ID).catch(() => null);
  if (guild) {
    try {
      await guild.commands.set(globalOk ? guildDefinitions : guildFallbackDefinitions);
    } catch (err) {
      console.error('Command registration failed:', err.message);
    }
    const tracking = await invites.prime(guild);
    console.log(`Ready for configured server: ${guild.name}. Invite tracking: ${tracking ? 'on' : 'off (needs Manage Server)'}. Run /setup to choose existing channels or create only the channels you want.`);
  } else {
    console.error(`Configured GUILD_ID ${config.GUILD_ID} is unavailable. Invite this new bot to that server and check .env.`);
  }
  // Offer tickets share the buy category again; drop any old split setting so
  // /ticket organize moves them back.
  if (db.getSetting('cat_offer')) {
    db.delSetting('cat_offer');
    console.log('Offer tickets now share the Buy Tickets category. Run /ticket organize to move existing ones.');
  }
  capes.syncCapeAssets(client).catch((err) => console.error('Cape sync failed:', err.message));
  vouches.ensureLeaderboardHistory(client).catch((err) => console.error('Vouch leaderboard migration failed:', err.message));
  setInterval(() => autodelete.sweep(client).catch(() => {}), 30 * 1000);
  setInterval(() => tickets.sweepCloses(client).catch(() => {}), 30 * 1000);
  setInterval(() => tickets.sweepInactivity(client).catch(() => {}), 60 * 1000);
  setInterval(() => vouches.renameSweep(client).catch(() => {}), 60 * 1000);
  setInterval(() => giveaways.sweep(client).catch(() => {}), 15 * 1000);
  giveaways.sweep(client).catch(() => {});
  setInterval(() => sync.poll(client).catch(() => {}), 10 * 1000);
  require('./services/backup').scheduleNightly(client);
});

client.on(Events.GuildCreate, async (guild) => {
  if (guild.id === config.GUILD_ID) {
    console.log('Joined the configured server, registering commands.');
    await initGuild(guild);
  }
});

const componentRouters = {
  pw: proxyWizard.handle,
  panel: proxyWizard.handle,
  rv: proxyReview.handle,
  ls: buyFlow.handle,
  tp: ticketFlow.handle,
  tk: ticketFlow.handle,
  cl: ticketFlow.handle,
  su: setupFlow.handle,
  gw: giveaways.toggleEntry,
  pr: pingRoles.handleToggle,
  imp: proxyWizard.handle,
  em: require('./interactions/embedFlow').handle,
};

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // User-installable commands run in DMs and in any server. In the configured
    // server they stay Administrator-only; elsewhere there is no gate.
    if (interaction.isChatInputCommand() && definitions.DM_COMMANDS.has(interaction.commandName)) {
      const inConfigGuild = interaction.inGuild() && interaction.guildId === config.GUILD_ID;
      if (inConfigGuild && !(await requireAdmin(interaction))) return;
      return await commands.dispatch(interaction);
    }
    // The crypto refresh button works wherever the converter was shown (incl. DMs).
    if (interaction.isButton() && interaction.customId.startsWith('cr:refresh:')) {
      const parts = interaction.customId.split(':');
      await interaction.deferUpdate();
      return await interaction.editReply(await buildCryptoMessage({
        currency: parts[2] && parts[2] !== 'none' ? parts[2] : null,
        amount: parts[3] && parts[3] !== 'none' ? Number(parts[3]) : null,
      }));
    }

    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'Use this inside the server.', flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (interaction.guildId !== config.GUILD_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot is configured for a different server.', flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (interaction.isChatInputCommand()) {
      // Member-usable commands do their own per-subcommand permission checks.
      if (!definitions.MEMBER_COMMANDS.has(interaction.commandName)
        && !(await requireAdmin(interaction))) return;
      return await commands.dispatch(interaction);
    }
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isModalSubmit()) {
      const parts = interaction.customId.split(':');
      const router = componentRouters[parts[0]];
      if (router) return await router(interaction, parts);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    logs.send(client, {
      title: 'Interaction error',
      description: `<@${interaction.user.id}> in <#${interaction.channelId}>\n\`\`\`${String(err.message).slice(0, 600)}\`\`\``,
      color: 0xed4245,
    });
    const payload = { content: 'Something went wrong. Try again or check the bot logs.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    } catch (innerErr) {
      // nothing else we can do
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    if (message.guildId !== config.GUILD_ID) return;

    // A deleted link must not continue through the vouch/ticket handlers.
    if (await linkfilter.handleMessage(message)) return;

    // Any human message resets that ticket's inactivity countdown.
    db.touchInactivityWatch(message.channelId, message.createdTimestamp);

    await autodelete.onUserMessage(client, message);

    if (message.channelId === db.getSetting('vouch_channel')) {
      await vouches.handleVouchMessage(message);
      return;
    }

    // Staff can add a user to a ticket by pinging them.
    const ticket = db.getTicketByChannel(message.channelId);
    if (ticket) {
      await tickets.cancelClose(
        message.channel,
        'Close request cancelled because someone sent a message in this ticket.'
      );
    }
    if (ticket && message.mentions.users.size && isAdmin(message.member)) {
      const added = [];
      for (const user of message.mentions.users.values()) {
        if (user.bot || user.id === ticket.creator_id) continue;
        if (message.channel.permissionOverwrites.cache.has(user.id)) continue;
        await message.channel.permissionOverwrites.edit(
          user.id,
          { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true },
          { type: OverwriteType.Member }
        );
        added.push(user.id);
      }
    }
  } catch (err) {
    console.error('Message handler error:', err);
  }
});

function messageJump(message) {
  return message.guildId && message.channelId
    ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    : '';
}

client.on(Events.MessageDelete, async (message) => {
  try {
    if (message.guildId !== config.GUILD_ID) return;
    await vouches.handleVouchDelete(client, message);
    if (message.author && message.author.bot) return;
    // Partial messages have no cached content; log what is known either way.
    logs.messageLog(client, {
      title: 'Message deleted',
      color: 0xed4245,
      description: `${message.author ? `<@${message.author.id}> (${message.author.tag})` : 'Unknown author'} in <#${message.channelId}>`,
      fields: [
        { name: 'Content', value: (message.content || '_not cached_').slice(0, 1000) || '_empty_', inline: false },
        ...(message.attachments && message.attachments.size
          ? [{ name: 'Attachments', value: [...message.attachments.values()].map((a) => a.url).join('\n').slice(0, 1000), inline: false }]
          : []),
      ],
    });
  } catch (err) {
    console.error('Message delete handler error:', err);
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (!newMessage || newMessage.guildId !== config.GUILD_ID) return;
    if (newMessage.author && newMessage.author.bot) return;
    const before = oldMessage ? oldMessage.content : null;
    const after = newMessage.content;
    if (before === after) return; // embeds resolving, pins, etc.
    logs.messageLog(client, {
      title: 'Message edited',
      description: `${newMessage.author ? `<@${newMessage.author.id}> (${newMessage.author.tag})` : 'Unknown author'} in <#${newMessage.channelId}>\n[Jump to message](${messageJump(newMessage)})`,
      fields: [
        { name: 'Before', value: (before || '_not cached_').slice(0, 1000) || '_empty_', inline: false },
        { name: 'After', value: (after || '_empty_').slice(0, 1000), inline: false },
      ],
    });
  } catch (err) {
    console.error('Message update handler error:', err);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message;
    if (!message.guild || message.guildId !== config.GUILD_ID) return;
    if (message.id !== db.getSetting('verify_message')) return;
    if (reaction.emoji.name !== config.VERIFY_EMOJI) return;
    const roleId = db.getSetting('member_role');
    if (!roleId) return;
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (member) await member.roles.add(roleId).catch((err) => console.error('Verify role add failed:', err.message));
  } catch (err) {
    console.error('Reaction handler error:', err);
  }
});

client.on(Events.InviteCreate, (invite) => {
  if (invite.guild && invite.guild.id === config.GUILD_ID) invites.onInviteCreate(invite);
});

client.on(Events.InviteDelete, (invite) => {
  if (invite.guild && invite.guild.id === config.GUILD_ID) invites.onInviteDelete(invite);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.guild.id !== config.GUILD_ID) return;
    const inviterId = await invites.onMemberAdd(member);
    logs.send(client, {
      title: 'Member joined',
      description: `<@${member.id}> (${member.user.tag})${inviterId && inviterId !== 'vanity' ? ` - invited by <@${inviterId}>` : inviterId === 'vanity' ? ' - via vanity URL' : ' - inviter unknown'}`,
    });
    if (inviterId && inviterId !== 'vanity') {
      await giveaways.onInviteCredited(client, inviterId).catch((err) => console.error('Invite-race check failed:', err.message));
    }
  } catch (err) {
    console.error('Member add handler error:', err);
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  try {
    if (member.guild.id !== config.GUILD_ID) return;
    invites.onMemberRemove(member);
    logs.send(client, { title: 'Member left', description: `<@${member.id}> (${member.user ? member.user.tag : member.id})` });
  } catch (err) {
    console.error('Member remove handler error:', err);
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(config.TOKEN);
