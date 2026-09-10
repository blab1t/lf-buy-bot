// Guards the inversion: a card must read as a WANTED request with a budget,
// never as a proxy listing with a BIN.
const assert = require('node:assert');
const listings = require('../src/services/listings');

const request = {
  id: 1,
  ign: '3-letter OG name',
  uuid: null,
  category: 'og',
  capes: [],
  info: { ranks: 'MVP+ or higher' },
  co: 'Offer',
  bin: '$250',
  status: 'published',
  requester_id: '1',
  ign_hidden: false,
  hide_proxy_label: false,
  created_at: Date.now(),
};

const text = JSON.stringify(listings.buildListingContainer(request, 'published').toJSON());

assert.ok(text.includes('WANTED'), 'published card must be labelled WANTED');
assert.ok(text.includes('Budget'), 'published card must show the budget');
assert.ok(text.includes('Best offer'), 'published card must show the best seller offer');
assert.ok(!text.includes('PROXY') && !text.includes('BIN:'), 'no proxy/BIN wording may survive');
// A request that names no real account has no player head to show.
assert.ok(!text.includes('mc-heads.net'), 'a description-only request has no avatar');
assert.ok(!listings.hasAvatar(request), 'hasAvatar is false without a resolved UUID');
assert.ok(listings.hasAvatar({ ...request, uuid: 'abc' }), 'hasAvatar is true for a resolved account');

const sold = JSON.stringify(listings.buildListingContainer({ ...request, status: 'sold' }, 'sold').toJSON());
assert.ok(sold.includes('FULFILLED'), 'a closed request reads as FULFILLED, not SOLD');

console.log('request card: all checks passed');
