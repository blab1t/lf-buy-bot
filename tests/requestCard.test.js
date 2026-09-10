// Guards the inversion: a card must read as a WANTED request with a budget
// range, never as a proxy listing with a BIN.
const assert = require('node:assert');
const listings = require('../src/services/listings');

const request = {
  id: 1,
  ign: '3-letter OG name',
  uuid: null,
  category: 'ogs',
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
assert.ok(!text.includes('Best offer'), 'no best-offer line until a seller actually offers');
const offered = JSON.stringify(listings.buildListingContainer({ ...request, co: '$80' }, 'published').toJSON());
assert.ok(offered.includes('Best offer'), 'an accepted offer does show up');
assert.ok(text.includes('Clean 3cn'), 'the description belongs on the card');
assert.ok(text.includes('Wants **2**'), 'the wanted amount belongs on the card');
assert.ok(!text.includes('PROXY') && !text.includes('BIN:'), 'no proxy/BIN wording may survive');

// A budget range renders as "from - to"; one bound alone renders alone.
assert.strictEqual(listings.displayBudget(request), '$50 - $100');
assert.strictEqual(listings.displayBudget({ ...request, info: {} }), '$100');
assert.strictEqual(listings.displayBudget({ bin: 'Offer', info: { price_min: '$50' } }), 'from $50');
assert.strictEqual(listings.displayBudget({ bin: 'Offer', info: {} }), 'Offer');

// A budget is typed as one number or one range.
assert.deepStrictEqual(listings.parseBudgetRange('50-100'), { min: '$50', max: '$100' });
assert.deepStrictEqual(listings.parseBudgetRange('100'), { min: 'Offer', max: '$100' });
assert.deepStrictEqual(listings.parseBudgetRange(''), { min: 'Offer', max: 'Offer' });
assert.throws(() => listings.parseBudgetRange('100-50'), /runs backwards/);
assert.throws(() => listings.parseBudgetRange('a lot'));
assert.strictEqual(listings.budgetInputValue(request), '$50 - $100');

// Wanting one (or none) is the default and stays off the card.
assert.strictEqual(listings.displayAmount(request), '2');
assert.strictEqual(listings.displayAmount({ info: { amount: '1' } }), null);
assert.strictEqual(listings.displayAmount({ info: { amount: '0' } }), null);
assert.strictEqual(listings.displayAmount({ info: {} }), null);
assert.strictEqual(listings.displayAmount({ info: { amount: '10+' } }), '10+');

// Requirements are paragraph boxes, so a seller gets whole sentences.
assert.ok(Object.values(listings.FIELDS).every((field) => field.multiline), 'detail fields are multiline');

// Fields follow the kind of thing wanted, and never exceed one Discord modal.
for (const [category, keys] of Object.entries(listings.FIELD_SETS)) {
  assert.ok(keys.length <= 5, `${category} asks for more fields than a modal holds`);
  for (const key of keys) assert.ok(listings.FIELDS[key], `${category} names an unknown field ${key}`);
}
assert.deepStrictEqual(
  Object.keys(listings.FIELD_SETS),
  ['ogs', 'semis', 'capes', 'stats', 'quickbuy', 'other'],
  'the sections are fixed: only staff add more'
);
assert.deepStrictEqual(
  listings.infoFieldsForCategory('stats').map((field) => field.key),
  ['ranks', 'stats', 'incidents', 'payment', 'extra'],
  'a stats request asks about ranks and stats'
);
assert.ok(listings.wantsCapes('capes') && !listings.wantsCapes('ogs'), 'only account sections pick capes');

// The channel name is prefilled from the title and stays editable.
const chan = listings.buildChannelNameModal('x', 'og-name').toJSON();
assert.strictEqual(chan.components[0].components[0].value, 'og-name');

// Whatever the kind, every remaining field can still be filled in by hand.
for (const category of [...Object.keys(listings.FIELD_SETS), 'made-up-key']) {
  const asked = new Set(listings.infoFieldsForCategory(category).map((field) => field.key));
  const extra = listings.extraFieldsForCategory(category).map((field) => field.key);
  assert.ok(extra.length > 0, `${category} offers no extra fields`);
  assert.ok(extra.every((key) => !asked.has(key)), `${category} offers a field it already asked for`);
  assert.strictEqual(asked.size + extra.length, Object.keys(listings.FIELDS).length,
    `${category} cannot reach every field`);
  assert.ok(extra.length <= 25, `${category} has more extra fields than a select menu holds`);
}
const picked = listings.buildPickedFieldsModal('x', ['stats', 'badges'], { stats: '300 stars' }).toJSON();
assert.strictEqual(picked.components.length, 2, 'the modal holds exactly the picked fields');
// An unknown or custom category still has a usable field set.
assert.ok(listings.infoFieldsForCategory('made-up-key').length > 0);

// A request that names no real account has no player head to show.
assert.ok(!text.includes('mc-heads.net'), 'a description-only request has no avatar');
assert.ok(!listings.hasAvatar(request), 'hasAvatar is false without a resolved UUID');
assert.ok(listings.hasAvatar({ ...request, uuid: 'abc' }), 'hasAvatar is true for a resolved account');

const sold = JSON.stringify(listings.buildListingContainer({ ...request, status: 'sold' }, 'sold').toJSON());
assert.ok(sold.includes('FULFILLED'), 'a closed request reads as FULFILLED, not SOLD');

console.log('request card: all checks passed');
