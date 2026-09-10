const {
  MessageFlags, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ChannelType,
} = require('discord.js');
const config = require('../config');
const { requireAdmin } = require('../util/perms');

const EPH = MessageFlags.Ephemeral;

// Accepts "#ff0000", "ff0000", "red", or blank for the bot's default grey.
const NAMED_COLORS = {
  grey: config.EMBED_COLOR, gray: config.EMBED_COLOR,
  red: 0xed4245, green: 0x57f287, blue: 0x5865f2, yellow: 0xfee75c,
  orange: 0xe67e22, purple: 0x9b59b6, pink: 0xeb459e, white: 0xffffff, black: 0x2b2d31,
};
function parseColor(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return config.EMBED_COLOR;
  if (NAMED_COLORS[value] !== undefined) return NAMED_COLORS[value];
  const hex = value.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
  return config.EMBED_COLOR;
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim());
}

// Modal fields are limited to five, so the builder covers the parts people
// actually use for notices like proxy fees.
function buildModal(customId, values = {}) {
  const field = (id, label, style, required, max, placeholder, value) => {
    const input = new TextInputBuilder()
      .setCustomId(id).setLabel(label).setStyle(style)
      .setRequired(required).setMaxLength(max);
    if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
    if (value) input.setValue(String(value).slice(0, max));
    return new ActionRowBuilder().addComponents(input);
  };
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Custom embed')
    .addComponents(
      field('title', 'Title', TextInputStyle.Short, false, 256, 'Proxy Fees', values.title),
      field('description', 'Description (line breaks work)', TextInputStyle.Paragraph, true, 3500,
        'Under $100 - 10%\n$100-$500 - 8%\nAbove $500 - 5%', values.description),
      field('color', 'Colour: hex like #5865f2, a name, or blank', TextInputStyle.Short, false, 20, 'grey', values.color),
      field('image', 'Image URL (optional)', TextInputStyle.Short, false, 400, 'https://...', values.image),
      field('footer', 'Footer (optional)', TextInputStyle.Short, false, 2048, 'Fees are deducted from the payout', values.footer),
    );
}

function embedFromFields(interaction) {
  const get = (id) => {
    try {
      return interaction.fields.getTextInputValue(id).trim();
    } catch (err) {
      return '';
    }
  };
  const title = get('title');
  const description = get('description');
  const image = get('image');
  const footer = get('footer');
  const embed = new EmbedBuilder()
    .setColor(parseColor(get('color')))
    .setDescription(description || null);
  if (title) embed.setTitle(title);
  if (image && isHttpUrl(image)) embed.setImage(image);
  if (footer) embed.setFooter({ text: footer });
  return { embed, badImage: Boolean(image) && !isHttpUrl(image) };
}

async function handle(interaction, parts) {
  if (!(await requireAdmin(interaction))) return;
  const action = parts[1];

  // parts: em:create:<channelId>
  if (action === 'create') {
    const { embed, badImage } = embedFromFields(interaction);
    const channel = await interaction.client.channels.fetch(parts[2]).catch(() => null);
    if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased()) {
      return interaction.reply({ content: 'That channel is not available anymore.', flags: EPH });
    }
    await interaction.deferReply({ flags: EPH });
    const message = await channel.send({ embeds: [embed] }).catch((err) => {
      interaction.editReply(`Could not post it: ${err.message}`).catch(() => {});
      return null;
    });
    if (!message) return null;
    require('../services/logs').send(interaction.client, {
      title: 'Embed posted',
      description: `<@${interaction.user.id}> posted a custom embed in <#${channel.id}>`,
    });
    return interaction.editReply({
      content: `Posted in <#${channel.id}>. Message ID \`${message.id}\` - edit it later with \`/embed edit message:${message.id}\`.${badImage ? '\n⚠️ The image URL was ignored because it is not a http(s) link.' : ''}`,
      allowedMentions: { parse: [] },
    });
  }

  // parts: em:edit:<channelId>:<messageId>
  if (action === 'edit') {
    const { embed, badImage } = embedFromFields(interaction);
    const channel = await interaction.client.channels.fetch(parts[2]).catch(() => null);
    const message = channel ? await channel.messages.fetch(parts[3]).catch(() => null) : null;
    if (!message) return interaction.reply({ content: 'That message no longer exists.', flags: EPH });
    await interaction.deferReply({ flags: EPH });
    await message.edit({ embeds: [embed] }).catch(() => {});
    require('../services/logs').send(interaction.client, {
      title: 'Embed edited',
      description: `<@${interaction.user.id}> edited an embed in <#${channel.id}>`,
    });
    return interaction.editReply({
      content: `Updated the embed in <#${channel.id}>.${badImage ? '\n⚠️ The image URL was ignored because it is not a http(s) link.' : ''}`,
      allowedMentions: { parse: [] },
    });
  }
  return null;
}

module.exports = { handle, buildModal, parseColor, ChannelType };
