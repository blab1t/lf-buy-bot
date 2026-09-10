const { WIZARD_TTL_MS } = require('../config');

// In-memory per-user wizard state. Lost on restart, which is fine for a
// short-lived creation flow.
const store = new Map();

function set(userId, data) {
  store.set(userId, { data, expires: Date.now() + WIZARD_TTL_MS });
  return data;
}

function get(userId) {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(userId);
    return null;
  }
  entry.expires = Date.now() + WIZARD_TTL_MS;
  return entry.data;
}

function clear(userId) {
  store.delete(userId);
}

module.exports = { set, get, clear };
