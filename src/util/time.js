const MIN_MS = 60 * 1000;
const MAX_MS = 14 * 24 * 60 * 60 * 1000;
const UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };

function clamp(ms) {
  return Math.max(MIN_MS, Math.min(MAX_MS, ms));
}

// Accepts "90" (minutes), "2h", "1d 12h", "45m", "2h30m"
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim().toLowerCase();
  if (!str) return null;
  if (/^\d+$/.test(str)) return clamp(parseInt(str, 10) * UNIT_MS.m);
  const re = /(\d+)\s*(d|h|m|s)/g;
  let ms = 0;
  let matched = false;
  let match;
  while ((match = re.exec(str))) {
    matched = true;
    ms += parseInt(match[1], 10) * UNIT_MS[match[2]];
  }
  return matched ? clamp(ms) : null;
}

function formatDuration(ms) {
  const parts = [];
  let rest = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(rest / 86400); rest -= days * 86400;
  const hours = Math.floor(rest / 3600); rest -= hours * 3600;
  const minutes = Math.floor(rest / 60); rest -= minutes * 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${rest}s`);
  return parts.join(' ');
}

module.exports = { parseDuration, formatDuration };
