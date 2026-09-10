const db = require('../db');
const { PROXY_CATEGORIES, CATEGORY_LABELS } = require('../config');

const MAX_CATEGORIES = 25;
const DISABLED_SETTING = 'disabled_proxy_categories';
const LABELS_SETTING = 'proxy_category_labels';

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function disabledKeys() {
  try {
    const value = JSON.parse(db.getSetting(DISABLED_SETTING) || '[]');
    return new Set(Array.isArray(value) ? value.filter((key) => PROXY_CATEGORIES.includes(key)) : []);
  } catch (err) {
    return new Set();
  }
}

function saveDisabledKeys(keys) {
  db.setSetting(DISABLED_SETTING, JSON.stringify([...keys]));
}

function labelOverrides() {
  try {
    const value = JSON.parse(db.getSetting(LABELS_SETTING) || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value).filter(([key, label]) => PROXY_CATEGORIES.includes(key) && typeof label === 'string' && label.trim())
    );
  } catch (err) {
    return {};
  }
}

function saveLabelOverrides(overrides) {
  db.setSetting(LABELS_SETTING, JSON.stringify(overrides));
}

function cleanLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 50);
}

function defaultCategories({ includeDisabled = false } = {}) {
  const disabled = disabledKeys();
  const overrides = labelOverrides();
  return PROXY_CATEGORIES
    .filter((key) => includeDisabled || !disabled.has(key))
    .map((key) => ({ key, label: overrides[key] || CATEGORY_LABELS[key] || key }));
}

function list() {
  const defaults = defaultCategories();
  const used = new Set(PROXY_CATEGORIES);
  const custom = db.listCustomProxyCategories().filter((category) => !used.has(category.key));
  return [...defaults, ...custom];
}

function resolve(value) {
  const input = String(value || '').trim().toLowerCase();
  const normalized = normalizeKey(value);
  return list().find(
    (category) => category.key === input || category.key === normalized || category.label.toLowerCase() === input
  ) || null;
}

function create(label) {
  const cleanedLabel = cleanLabel(label);
  const key = normalizeKey(cleanedLabel);
  if (cleanedLabel.length < 2 || !key) throw new Error('Use a category name with at least two letters or numbers.');
  const builtIn = defaultCategories({ includeDisabled: true }).find(
    (category) => category.key === key || category.label.toLowerCase() === cleanedLabel.toLowerCase()
  );
  if (builtIn) {
    const disabled = disabledKeys();
    if (!disabled.has(builtIn.key)) throw new Error('That proxy category already exists.');
    if (list().length >= MAX_CATEGORIES) throw new Error(`Discord allows up to ${MAX_CATEGORIES} proxy categories.`);
    disabled.delete(builtIn.key);
    saveDisabledKeys(disabled);
    return builtIn;
  }
  if (list().length >= MAX_CATEGORIES) throw new Error(`Discord allows up to ${MAX_CATEGORIES} proxy categories.`);
  if (resolve(cleanedLabel) || resolve(key)) throw new Error('That proxy category already exists.');
  db.addCustomProxyCategory(key, cleanedLabel);
  return { key, label: cleanedLabel };
}

function rename(value, label) {
  const category = resolve(value);
  if (!category) throw new Error('That proxy category does not exist.');
  const clean = cleanLabel(label);
  if (clean.length < 2) throw new Error('Use a category name with at least two characters.');
  if (list().some((entry) => entry.key !== category.key && entry.label.toLowerCase() === clean.toLowerCase())) {
    throw new Error('Another proxy category already has that name.');
  }
  if (PROXY_CATEGORIES.includes(category.key)) {
    const overrides = labelOverrides();
    overrides[category.key] = clean;
    saveLabelOverrides(overrides);
    return { ...category, previousLabel: category.label, label: clean, builtIn: true };
  }
  if (!db.renameCustomProxyCategory(category.key, clean)) throw new Error('That custom proxy category no longer exists.');
  return { ...category, previousLabel: category.label, label: clean, builtIn: false };
}

function remove(value) {
  const category = resolve(value);
  if (!category) throw new Error('That proxy category does not exist.');
  if (db.countListingsForCategory(category.key)) {
    throw new Error('Move or delete every listing in that category before deleting it.');
  }
  if (PROXY_CATEGORIES.includes(category.key)) {
    const disabled = disabledKeys();
    disabled.add(category.key);
    saveDisabledKeys(disabled);
    return { ...category, builtIn: true };
  }
  db.removeCustomProxyCategory(category.key);
  return { ...category, builtIn: false };
}

module.exports = { list, resolve, create, rename, remove, normalizeKey };
