const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { Jimp, ResizeStrategy } = require('jimp');
const db = require('../db');

const CAPES_PATH = path.join(__dirname, '..', '..', 'data', 'capes.json');

let registry = [];
try {
  registry = JSON.parse(fs.readFileSync(CAPES_PATH, 'utf8'));
} catch (err) {
  console.error('Could not read data/capes.json:', err.message);
}

// key -> ApplicationEmoji
const emojiMap = new Map();
// md5 of raw texture png -> cape key (laby.net reports history as file md5)
let md5Map = {};
try {
  md5Map = JSON.parse(db.getSetting('cape_md5_map') || '{}');
} catch (err) {
  md5Map = {};
}

function hashFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/texture\/([a-f0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function emojiNameFor(key) {
  return `cape_${key}`.slice(0, 32);
}

function getCape(key) {
  return registry.find((c) => c.key === key) || null;
}

function capeLabel(key) {
  const cape = getCape(key);
  return cape ? cape.name : key;
}

function capeEmoji(key) {
  const emoji = emojiMap.get(key);
  return emoji ? `<:${emoji.name}:${emoji.id}>` : '🧥';
}

function capeEmojiId(key) {
  const emoji = emojiMap.get(key);
  return emoji ? emoji.id : null;
}

function capeLine(keys) {
  if (!keys || !keys.length) return 'No capes';
  return keys.map((key) => `${capeEmoji(key)} ${capeLabel(key)}`).join('  ');
}

// Crop the front face of a standard 64x32 cape texture and upscale it.
async function textureToEmojiPng(buffer) {
  const image = await Jimp.read(buffer);
  const scale = Math.max(1, Math.floor(image.bitmap.width / 64));
  image.crop({ x: 1 * scale, y: 1 * scale, w: 10 * scale, h: 16 * scale });
  image.resize({ w: 80, h: 128, mode: ResizeStrategy.NEAREST_NEIGHBOR });
  return image.getBuffer('image/png');
}

async function fetchTexture(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`texture fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Downloads registry textures once to build emojis and the md5 lookup map.
async function syncCapeAssets(client) {
  let existing;
  try {
    existing = await client.application.emojis.fetch();
  } catch (err) {
    console.error('Could not fetch application emojis:', err.message);
    existing = new Map();
  }
  const byName = new Map([...existing.values()].map((e) => [e.name, e]));
  let mapChanged = false;
  for (const cape of registry) {
    const found = byName.get(emojiNameFor(cape.key));
    if (found) emojiMap.set(cape.key, found);
    const needEmoji = !found && cape.textureUrl;
    const needMd5 = cape.textureUrl && !Object.values(md5Map).includes(cape.key);
    if (!needEmoji && !needMd5) continue;
    try {
      const raw = await fetchTexture(cape.textureUrl);
      if (needMd5) {
        const md5 = nodeCrypto.createHash('md5').update(raw).digest('hex');
        md5Map[md5] = cape.key;
        mapChanged = true;
      }
      if (needEmoji) {
        const png = await textureToEmojiPng(raw);
        const emoji = await client.application.emojis.create({
          attachment: png,
          name: emojiNameFor(cape.key),
        });
        emojiMap.set(cape.key, emoji);
        console.log(`Created cape emoji for ${cape.name}`);
      }
    } catch (err) {
      console.error(`Cape asset failed for ${cape.name}: ${err.message}`);
    }
  }
  if (mapChanged) db.setSetting('cape_md5_map', JSON.stringify(md5Map));
}

function dashUuid(uuid) {
  const clean = String(uuid).replace(/-/g, '');
  if (clean.length !== 32) return uuid;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

// Which registry capes has this account been seen with? Best effort:
// the equipped cape from Mojang plus cape history from laby.net.
async function detectCapes(uuid, equippedCapeUrl) {
  const detected = new Set();
  const equippedHash = hashFromUrl(equippedCapeUrl);
  if (equippedHash) {
    const match = registry.find((c) => hashFromUrl(c.textureUrl) === equippedHash);
    if (match) detected.add(match.key);
  }
  if (uuid) {
    try {
      const res = await fetch(`https://laby.net/api/user/${dashUuid(uuid)}/get-textures`, {
        headers: { 'User-Agent': 'discord-shop-bot/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const body = await res.json();
        const entries = Array.isArray(body.CAPE) ? body.CAPE : [];
        for (const entry of entries) {
          const key = md5Map[String(entry.file_hash || '').toLowerCase()];
          if (key) detected.add(key);
        }
      }
    } catch (err) {
      // laby.net is best effort only
    }
  }
  return [...detected];
}

// Discord caps string selects at 25 options, so the registry is split into
// stable pages. Every cape stays reachable regardless of what is selected.
const PAGE_SIZE = 25;

function capeSelectPages(selectedKeys = []) {
  const selected = new Set(selectedKeys);
  const pages = [];
  for (let start = 0; start < registry.length; start += PAGE_SIZE) {
    const chunk = registry.slice(start, start + PAGE_SIZE);
    pages.push({
      index: pages.length,
      options: chunk.map((cape) => {
        const option = {
          label: cape.name.slice(0, 100),
          value: cape.key,
          default: selected.has(cape.key),
        };
        const emojiId = capeEmojiId(cape.key);
        if (emojiId) option.emoji = { id: emojiId };
        return option;
      }),
    });
  }
  return pages;
}

function capePageKeys(pageIndex) {
  const start = pageIndex * PAGE_SIZE;
  return registry.slice(start, start + PAGE_SIZE).map((c) => c.key);
}

// A select submit only reports values for its own page, so keep every
// selected cape that lives on other pages and swap in this page's values.
function mergePageSelection(currentKeys, pageIndex, pageValues) {
  const pageKeys = new Set(capePageKeys(pageIndex));
  const kept = (currentKeys || []).filter((key) => !pageKeys.has(key));
  return [...new Set([...kept, ...pageValues])];
}

module.exports = {
  registry, getCape, capeLabel, capeEmoji, capeEmojiId, capeLine,
  syncCapeAssets, detectCapes, capeSelectPages, mergePageSelection,
};
