const IGN_RE = /^[A-Za-z0-9_]{1,16}$/;

function isValidIgn(name) {
  return IGN_RE.test(name);
}

// People often type "hidden" into the username field when they mean "keep my
// IGN private". Those words are valid Minecraft names, so they need catching
// explicitly and pointing at the hide toggle instead.
const HIDDEN_PLACEHOLDERS = new Set([
  'hidden', 'hide', 'hiddenign', 'hideign', 'private', 'privateign', 'anon', 'anonymous',
  'secret', 'censored', 'none', 'unknown', 'na', 'nan', 'null', 'redacted', 'ask', 'dm',
]);

function isHiddenPlaceholder(name) {
  return HIDDEN_PLACEHOLDERS.has(String(name || '').trim().toLowerCase().replace(/[^a-z]/g, ''));
}

// Returns { uuid, name } or null when the account does not exist.
async function resolveUser(name) {
  if (!isValidIgn(name)) return null;
  const res = await fetch(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Mojang API responded with ${res.status}`);
  const data = await res.json();
  if (!data || !data.id) return null;
  return { uuid: data.id, name: data.name };
}

// Returns { skinUrl, capeUrl } from the session server, values may be null.
async function getProfileTextures(uuid) {
  const res = await fetch(
    `https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(uuid)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return { skinUrl: null, capeUrl: null };
  const data = await res.json();
  const prop = (data.properties || []).find((p) => p.name === 'textures');
  if (!prop) return { skinUrl: null, capeUrl: null };
  try {
    const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
    const textures = decoded.textures || {};
    return {
      skinUrl: textures.SKIN ? textures.SKIN.url : null,
      capeUrl: textures.CAPE ? textures.CAPE.url : null,
    };
  } catch (err) {
    return { skinUrl: null, capeUrl: null };
  }
}

module.exports = { isValidIgn, isHiddenPlaceholder, resolveUser, getProfileTextures };
