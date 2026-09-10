const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { EMBED_COLOR } = require('../config');

const COINS = [
  { id: 'bitcoin', symbol: 'BTC', emoji: '🟠', aliases: ['btc', 'bitcoin', 'xbt'] },
  { id: 'ethereum', symbol: 'ETH', emoji: '🔷', aliases: ['eth', 'ethereum', 'ether'] },
  { id: 'solana', symbol: 'SOL', emoji: '🟣', aliases: ['sol', 'solana'] },
  { id: 'litecoin', symbol: 'LTC', emoji: '⚪', aliases: ['ltc', 'litecoin'] },
];

const FIATS = {
  usd: { label: 'USD', symbol: '$', aliases: ['usd', 'us', 'dollar', 'dollars', 'usdollar', '$'] },
  eur: { label: 'EUR', symbol: '€', aliases: ['eur', 'euro', 'euros', '€'] },
  gbp: { label: 'GBP', symbol: '£', aliases: ['gbp', 'pound', 'pounds', 'quid', '£'] },
  cad: { label: 'CAD', symbol: 'C$', aliases: ['cad', 'canadian'] },
  aud: { label: 'AUD', symbol: 'A$', aliases: ['aud', 'australian'] },
  jpy: { label: 'JPY', symbol: '¥', aliases: ['jpy', 'yen', '¥'] },
};

const FIAT_CODES = Object.keys(FIATS);
const REF_COIN = 'bitcoin';

let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

function formatPrice(value, symbol) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '?';
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : 4;
  return `${symbol}${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatCoinAmount(value) {
  if (!Number.isFinite(value)) return '?';
  const digits = value >= 1 ? 4 : 8;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

async function fetchPrices() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const ids = COINS.map((coin) => coin.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${FIAT_CODES.join(',')}`;
  const headers = {};
  const apiKey = (process.env.COINGECKO_API_KEY || '').trim();
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`CoinGecko responded with ${response.status}`);
  const data = await response.json();
  cache = { at: Date.now(), data };
  return data;
}

// Resolve a free-text token into either a supported coin or fiat, so users can
// type "btc", "LTC", "usd" or "€" in the same field.
function resolveCurrency(input) {
  const token = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!token) return null;
  const coin = COINS.find(
    (c) => c.id === token || c.symbol.toLowerCase() === token || c.aliases.includes(token)
  );
  if (coin) return { type: 'coin', coin };
  for (const code of FIAT_CODES) {
    if (code === token || FIATS[code].aliases.includes(token)) return { type: 'fiat', code };
  }
  return null;
}

// Short token stored on the Refresh button so it can rebuild the same message.
function currencyToken(resolved) {
  if (!resolved) return null;
  return resolved.type === 'coin' ? resolved.coin.symbol.toLowerCase() : resolved.code;
}

function acceptedCurrenciesText() {
  const coins = COINS.map((c) => c.symbol).join(', ');
  const fiats = FIAT_CODES.map((c) => FIATS[c].label).join(', ');
  return `**Crypto:** ${coins}\n**Cash:** ${fiats}`;
}

// USD value of `amount` units of the resolved currency. Fiat cross-rates are
// derived from the reference coin priced in every fiat.
function usdValueOf(amount, resolved, data) {
  if (resolved.type === 'coin') {
    return amount * Number(data[resolved.coin.id].usd);
  }
  const ref = data[REF_COIN];
  return amount * (Number(ref.usd) / Number(ref[resolved.code]));
}

function fiatFromUsd(usdValue, code, data) {
  const ref = data[REF_COIN];
  return usdValue * (Number(ref[code]) / Number(ref.usd));
}

function refreshRow(token, amount) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cr:refresh:${token || 'none'}:${amount === null || amount === undefined ? 'none' : amount}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄')
  );
}

function pricesEmbed(data, fiatCodes) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Crypto Prices')
    .setTimestamp(new Date());
  for (const coin of COINS) {
    const entry = data[coin.id] || {};
    const lines = fiatCodes.map(
      (code) => `**${FIATS[code].label}:** ${formatPrice(Number(entry[code]), FIATS[code].symbol)}`
    );
    embed.addFields({ name: `${coin.emoji} ${coin.symbol}`, value: lines.join('\n'), inline: true });
  }
  embed.setFooter({ text: 'Prices by CoinGecko, cached for 60s' });
  return embed;
}

function conversionEmbed(amount, resolved, data) {
  const usdValue = usdValueOf(amount, resolved, data);
  const inputLabel = resolved.type === 'coin'
    ? `${formatCoinAmount(amount)} ${resolved.coin.symbol}`
    : `${formatPrice(amount, FIATS[resolved.code].symbol)} ${FIATS[resolved.code].label}`;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Crypto Converter')
    .setDescription(`**${inputLabel}** is worth:`)
    .setTimestamp(new Date());

  const cryptoLines = [];
  for (const coin of COINS) {
    if (resolved.type === 'coin' && resolved.coin.id === coin.id) continue;
    cryptoLines.push(`${coin.emoji} **${coin.symbol}:** ${formatCoinAmount(usdValue / Number(data[coin.id].usd))}`);
  }
  const cashLines = [];
  for (const code of FIAT_CODES) {
    if (resolved.type === 'fiat' && resolved.code === code) continue;
    cashLines.push(`**${FIATS[code].label}:** ${formatPrice(fiatFromUsd(usdValue, code, data), FIATS[code].symbol)}`);
  }
  if (cryptoLines.length) embed.addFields({ name: '🪙 Crypto', value: cryptoLines.join('\n'), inline: true });
  if (cashLines.length) embed.addFields({ name: '💵 Cash', value: cashLines.join('\n'), inline: true });
  embed.setFooter({ text: 'Rates by CoinGecko, cached for 60s' });
  return embed;
}

// Central builder for /crypto and its Refresh button. Modes:
//  - amount + currency  -> convert into every other coin and cash
//  - currency only      -> that coin's 1-unit conversion, or that fiat's prices
//  - nothing            -> current prices in USD and EUR
async function buildCryptoMessage({ amount = null, currency = null } = {}) {
  const numericAmount = amount === null || amount === undefined || amount === ''
    ? null
    : Number.isFinite(Number(amount)) && Number(amount) >= 0 ? Number(amount) : null;
  const resolved = currency ? resolveCurrency(currency) : null;

  if (currency && !resolved) {
    return {
      embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Unknown currency')
        .setDescription(`I do not recognise **${String(currency).slice(0, 40)}**.\n\n${acceptedCurrenciesText()}`)],
      components: [],
    };
  }
  if (numericAmount !== null && !resolved) {
    return {
      embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Pick a currency')
        .setDescription(`Add a \`currency\` for your amount so I know what to convert.\n\n${acceptedCurrenciesText()}`)],
      components: [],
    };
  }

  let data = null;
  try {
    data = await fetchPrices();
  } catch (err) {
    return {
      embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription('Could not fetch rates right now, try again in a minute.')],
      components: [refreshRow(currencyToken(resolved), numericAmount)],
    };
  }

  if (numericAmount !== null && resolved) {
    return { embeds: [conversionEmbed(numericAmount, resolved, data)], components: [refreshRow(currencyToken(resolved), numericAmount)] };
  }
  if (resolved) {
    if (resolved.type === 'fiat') {
      return { embeds: [pricesEmbed(data, [resolved.code])], components: [refreshRow(currencyToken(resolved), null)] };
    }
    return { embeds: [conversionEmbed(1, resolved, data)], components: [refreshRow(currencyToken(resolved), 1)] };
  }
  return { embeds: [pricesEmbed(data, ['usd', 'eur'])], components: [refreshRow(null, null)] };
}

module.exports = { buildCryptoMessage };
