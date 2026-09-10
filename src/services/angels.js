const config = require('../config');
const listings = require('./listings');

// Angels API (https://api.vlonk102.co.uk) mirror of our public listings.
// Every call is best-effort: the shop must keep working if the API is down,
// so failures are logged and swallowed rather than thrown.
const BASE = (process.env.ANGELS_API_BASE || 'https://api.vlonk102.co.uk').replace(/\/+$/, '');
const TIMEOUT_MS = 10000;

// An invalid key would otherwise fail on every listing update, so the mirror
// switches itself off after an auth rejection until the bot restarts.
let authBlocked = false;

function enabled() {
  return Boolean(config.ANGELS_API_KEY) && !authBlocked;
}

function authRejected() {
  return authBlocked;
}

async function request(method, path, params = {}) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'no API key configured' };
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  try {
    const response = await fetch(url, {
      method,
      headers: { 'API-Key': config.ANGELS_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await response.json();
    } catch (err) {
      body = null;
    }
    if (!response.ok) {
      console.error(`Angels API ${method} ${path} -> ${response.status}${body && body.error ? `: ${body.error}` : ''}`);
      if (response.status === 403 && body && /invalid api key/i.test(String(body.error || ''))) {
        authBlocked = true;
        console.error('Angels API key was rejected; the mirror is paused until the bot restarts. Fix ANGELS_API_KEY and restart.');
      }
      return { ok: false, status: response.status, body };
    }
    return { ok: true, status: response.status, body };
  } catch (err) {
    console.error(`Angels API ${method} ${path} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// co/bin are floats in the API, while listings store display strings such as
// "$100" or "Offer".
function priceNumber(value) {
  const amount = listings.usdToNumber(value);
  return amount === null ? null : amount;
}

function addListing({ channelId, co = null, bin = null, uuid = null, username = null }) {
  return request('POST', '/listings/add', {
    channel_id: channelId,
    co: priceNumber(co),
    bin: priceNumber(bin),
    uuid,
    username,
  });
}

function markSold(channelId) {
  return request('POST', '/listings/sold', { channel_id: channelId });
}

function removeListing(channelId) {
  return request('DELETE', '/listings/remove', { channel_id: channelId });
}

function removeAll() {
  return request('DELETE', '/listings/removeall', {});
}

// Mirrors a listing's current state. Called from the same choke point that
// drives cross-server sync, so every price change, sale and deletion is pushed.
async function syncListing(listingRow) {
  if (!enabled()) return { ok: false, skipped: true };
  const listing = listingRow && listingRow.capes !== undefined && typeof listingRow.capes === 'string'
    ? require('../db').parseListing(listingRow)
    : listingRow;
  if (!listing || !listing.listing_channel_id) return { ok: false, skipped: true };
  if (listing.status === 'deleted' || listing.status === 'denied') {
    return removeListing(listing.listing_channel_id);
  }
  if (listing.status === 'sold') {
    // Make sure the listing exists before flagging it, so a sale that happens
    // before the first sync still lands, then take it off the board entirely.
    await addListing({
      channelId: listing.listing_channel_id,
      co: listing.co,
      bin: listing.bin,
      uuid: listing.uuid,
      username: listing.ign_hidden ? null : listing.ign,
    });
    await markSold(listing.listing_channel_id);
    return removeListing(listing.listing_channel_id);
  }
  if (listing.status !== 'published') return { ok: false, skipped: true };
  return addListing({
    channelId: listing.listing_channel_id,
    co: listing.co,
    bin: listing.bin,
    uuid: listing.uuid,
    username: listing.ign_hidden ? null : listing.ign,
  });
}

module.exports = { enabled, authRejected, addListing, markSold, removeListing, removeAll, syncListing, BASE };
