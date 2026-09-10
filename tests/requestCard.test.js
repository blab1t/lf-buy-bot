// Guards the inversion: a card must read as a WANTED request with a budget
// range, never as a proxy listing with a BIN.
const assert = require('node:assert');
const listings = require('../src/services/listings');

const request = {
  id: 1,
  ign: '3-letter OG name',
  uuid: null,
  category: 'name',
  capes: [],
  info: {
    description: 'Clean 3cn, letters only.',
    price_min: '$50',
    amount: '2',
    nametype: '3cn letters',
    namechanges: '0nc',
  },
  co: 'Offer',
  bin: '$100',
  status: 'published',
  requester_id: '1',
  ign_hidden: false,
  hide_proxy_label: false,
  created_at: Date.now(),
};

const text = JSON.stringify(listings.buildListingContainer(request, 'published').toJSON());

assert.ok(text.includes('WANTED'), 'published card must be labelled WANTED');
assert.ok(text.includes('Best offer'), 'published card must show the best seller offer');
assert.ok(text.includes('Clean 3cn'), 'the description belongs on the card');
assert.ok(text.includes('Wants **2**'), 'the wanted amount belongs on the card');
assert.ok(!text.includes('PROXY') && !text.includes('BIN:'), 'no proxy/BIN wording may survive');

// A budget range renders as "from - to"; one bound alone renders alone.
assert.strictEqual(listings.displayBudget(request), '$50 - $100');
assert.strictEqual(listings.displayBudget({ ...request, info: {} }), '$100');
assert.strictEqual(listings.displayBudget({ bin: 'Offer', info: { price_min: '$50' } }), 'from $50');
assert.strictEqual(listings.displayBudget({ bin: 'Offer', info: {} }), 'Offer');

// Fields follow the kind of thing wanted, and never exceed one Discord modal.
for (const [category, keys] of Object.entries(listings.FIELD_SETS)) {
  assert.ok(keys.length <= 5, `${category} asks for more fields than a modal holds`);
  for (const key of keys) assert.ok(listings.FIELDS[key], `${category} names an unknown field ${key}`);
}
assert.deepStrictEqual(
  listings.infoFieldsForCategory('youtube').map((field) => field.key),
  ['members', 'niche', 'handle', 'incidents', 'extra'],
  'a YouTube request asks about subscribers, not FKDR'
);
assert.ok(listings.wantsCapes('capes') && !listings.wantsCapes('discord'), 'only account requests pick capes');
// An unknown or custom category still has a usable field set.
assert.ok(listings.infoFieldsForCategory('made-up-key').length > 0);

// A request that names no real account has no player head to show.
assert.ok(!text.includes('mc-heads.net'), 'a description-only request has no avatar');
assert.ok(!listings.hasAvatar(request), 'hasAvatar is false without a resolved UUID');
assert.ok(listings.hasAvatar({ ...request, uuid: 'abc' }), 'hasAvatar is true for a resolved account');

const sold = JSON.stringify(listings.buildListingContainer({ ...request, status: 'sold' }, 'sold').toJSON());
assert.ok(sold.includes('FULFILLED'), 'a closed request reads as FULFILLED, not SOLD');

console.log('request card: all checks passed');
