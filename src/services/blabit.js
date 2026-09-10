const { BLABIT_API_KEY } = require('../config');

// blabit.dev proxies the Hypixel player endpoint, responses are identical.
// Rate limit: 120 requests per minute, far above what the wizard needs.

const RANK_NAMES = {
  VIP: 'VIP',
  VIP_PLUS: 'VIP+',
  MVP: 'MVP',
  MVP_PLUS: 'MVP+',
  SUPERSTAR: 'MVP++',
  YOUTUBER: 'YouTube',
  ADMIN: 'Admin',
  GAME_MASTER: 'GM',
  MODERATOR: 'Mod',
};

function rankOf(player) {
  if (player.rank && player.rank !== 'NORMAL') return RANK_NAMES[player.rank] || player.rank;
  if (player.monthlyPackageRank === 'SUPERSTAR') return 'MVP++';
  if (player.newPackageRank && player.newPackageRank !== 'NONE') {
    return RANK_NAMES[player.newPackageRank] || player.newPackageRank;
  }
  return 'Non';
}

function networkLevel(exp) {
  if (!exp || exp <= 0) return 1;
  return Math.max(1, Math.floor(Math.sqrt(2 * exp + 30625) / 50 - 2.5));
}

// 72000 -> "72k", 19850 -> "19.9k", 850 -> "850"
function kFormat(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  const k = num / 1000;
  const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${rounded}k`;
}

function trimNumber(value) {
  return String(Math.round(value * 10) / 10).replace(/\.0$/, '');
}

function roundStarsForName(value) {
  const number = Math.max(0, Number(value) || 0);
  return number < 50 ? Math.round(number) : Math.round(number / 50) * 50;
}

function roundFkdrForName(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

// Returns { ranksNwl, stats, nameSuggestion } prefills, or null when no
// key/no data. Stats: "1400⭐ 35 fkdr 72k finals 20k wins | 6k duels wins 4 wlr".
// nameSuggestion (used for Stats listing channel names): "1400⭐-35fkdr🟦⬛";
// accounts below 100 stars use "35fkdr-50⭐". 🟦 = 100+ ranks gifted,
// ⬛ = network level 250+.
async function getPrefill(uuid) {
  if (!BLABIT_API_KEY || !uuid) return null;
  try {
    const url = `https://api.blabit.dev/player?key=${encodeURIComponent(BLABIT_API_KEY)}&uuid=${encodeURIComponent(uuid)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.success || !body.player) return null;
    const player = body.player;
    const achievements = player.achievements || {};
    const stats = player.stats || {};
    const bw = stats.Bedwars || {};
    const duels = stats.Duels || {};
    const nwl = networkLevel(player.networkExp);

    const ranksNwl = `${rankOf(player)} | ${nwl} nwl`;

    const parts = [`${achievements.bedwars_level || 0}⭐`];
    const fkdr = bw.final_deaths_bedwars
      ? (bw.final_kills_bedwars || 0) / bw.final_deaths_bedwars
      : bw.final_kills_bedwars || 0;
    if (Math.round(fkdr) >= 3) parts.push(`${trimNumber(fkdr)} fkdr`);
    if (bw.final_kills_bedwars) parts.push(`${kFormat(bw.final_kills_bedwars)} finals`);
    if (bw.wins_bedwars) parts.push(`${kFormat(bw.wins_bedwars)} wins`);

    if (duels.wins) {
      const wlr = duels.losses ? duels.wins / duels.losses : duels.wins;
      parts.push(`| ${kFormat(duels.wins)} duels wins ${trimNumber(wlr)} wlr`);
    }

    const ranksGifted = (player.giftingMeta && player.giftingMeta.ranksGiven) || 0;
    const squares = `${ranksGifted >= 100 ? '🟦' : ''}${nwl >= 250 ? '⬛' : ''}`;

    const roundedStars = roundStarsForName(achievements.bedwars_level);
    const roundedFkdr = roundFkdrForName(fkdr);
    // Stats channels always read stars-fkdr. Channel positions inside the Stats
    // category are arranged by rounded stars first, with FKDR only breaking ties.
    const roundedNameSuggestion = `${roundedStars}\u2b50-${roundedFkdr}fkdr${squares}`;
    return { ranksNwl, stats: parts.join(' '), nameSuggestion: roundedNameSuggestion };
  } catch (err) {
    console.error('blabit prefill failed:', err.message);
    return null;
  }
}

module.exports = { getPrefill };
