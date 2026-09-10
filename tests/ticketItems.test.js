// Self-check for multi-item tickets: one ticket channel hosting several
// proxies, offers and BINs at once. Run with `node tests/ticketItems.test.js`.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = path.join(os.tmpdir(), `tickets-test-${Date.now()}.db`);
process.env.DB_PATH = tmp;
const db = require('../src/db');

function makeListing(ign) {
  return db.createListing({
    ign, uuid: null, category: 'other', capes: [], info: {},
    co: 'Offer', bin: '$100', requesterId: 'owner1',
  });
}

// A support ticket starts with no items at all.
const support = db.createTicket({
  number: 1, channelId: 'chan-support', type: 'support', creatorId: 'buyer1',
});
assert.strictEqual(db.ticketItems(support.id).length, 0);

// An offer joins it, then a BIN on a different listing, then two proxies.
const a = makeListing('AccountA');
const b = makeListing('AccountB');
const offer = db.addTicketItem({
  ticketId: support.id, kind: 'offer', listingId: a.id,
  offerAmount: '$50', offerStatus: 'pending',
});
db.addTicketItem({ ticketId: support.id, kind: 'bin', listingId: b.id });
const first = db.attachListingToTicket(support.id, a.id);
const second = db.attachListingToTicket(support.id, b.id);

assert.strictEqual(db.ticketItems(support.id).length, 4, 'ticket hosts four items');
// The ticket already had items, so neither proxy hijacks its identity.
assert.strictEqual(first.primary, false);
assert.strictEqual(second.primary, false);
assert.strictEqual(db.getTicket(support.id).type, 'support');

// Item reads carry the ticket's own fields, so old ticket-shaped call sites work.
assert.strictEqual(offer.channel_id, 'chan-support');
assert.strictEqual(offer.creator_id, 'buyer1');
assert.strictEqual(offer.id, support.id);

// Two buyers can hold offers on the same listing from different tickets.
const other = db.createTicket({
  number: 2, channelId: 'chan-offer', type: 'offer', creatorId: 'buyer2',
  listingId: a.id, offerAmount: '$60', offerStatus: 'pending',
});
assert.strictEqual(db.firstTicketItem(other.id).offer_amount, '$60', 'creation makes the first item');
assert.strictEqual(db.offerTicketsForListing(a.id).length, 2);
assert.strictEqual(db.findOpenTicketItem('offer', a.id, 'buyer1').item_id, offer.item_id);
assert.strictEqual(db.findOpenTicketItem('bin', b.id, 'buyer1').kind, 'bin');
assert.strictEqual(db.findOpenTicketItem('offer', b.id, 'buyer1'), undefined);

// Reviewing one offer leaves the other alone.
db.updateTicketItemOfferStatus(offer.item_id, 'accepted');
assert.strictEqual(db.getTicketItem(offer.item_id).offer_status, 'accepted');
assert.strictEqual(db.firstTicketItem(other.id).offer_status, 'pending');

// Legacy buttons carry a ticket id and still resolve to that ticket's offer.
assert.strictEqual(db.pendingOfferItemForTicket(other.id, a.id).offer_amount, '$60');
assert.strictEqual(db.pendingOfferItemForTicket(support.id, a.id), undefined, 'accepted offers are not pending');

// Closing the support ticket must finalise both of its proxies and neither of
// the listings it only references through the offer/BIN items.
const owned = db.ticketItems(support.id).filter((item) => item.kind === 'proxy').map((item) => item.listing_id);
assert.deepStrictEqual([...new Set(owned)].sort(), [a.id, b.id].sort());

// An empty ticket's first proxy does become its identity.
const blank = db.createTicket({ number: 3, channelId: 'chan-blank', type: 'support', creatorId: 'buyer3' });
const promoted = db.attachListingToTicket(blank.id, a.id);
assert.strictEqual(promoted.primary, true);
assert.strictEqual(promoted.ticket.type, 'proxy');
assert.strictEqual(promoted.ticket.listing_id, a.id);

// Reviving an offer reopens its ticket.
db.markTicketClosed(other.id);
const revived = db.reviveOfferItem(db.firstTicketItem(other.id).item_id, '$75');
assert.strictEqual(revived.offer_amount, '$75');
assert.strictEqual(revived.status, 'open');

// "Offer again" in a ticket: the pending guard blocks a second live offer, a
// reviewed one lets the buyer re-bid, and the re-bid stacks on the same ticket
// rather than replacing the old one or opening a channel.
const bidder = db.createTicket({
  number: 9, channelId: 'chan-bid', type: 'offer', creatorId: 'buyer9',
  listingId: b.id, offerAmount: '$10', offerStatus: 'pending',
});
assert.strictEqual(db.findOpenTicketItem('offer', b.id, 'buyer9').offer_status, 'pending', 'live offer blocks re-bid');
db.updateTicketItemOfferStatus(db.firstTicketItem(bidder.id).item_id, 'declined');
assert.strictEqual(db.findOpenTicketItem('offer', b.id, 'buyer9').offer_status, 'declined', 'reviewed offer frees the button');
db.addTicketItem({ ticketId: bidder.id, kind: 'offer', listingId: b.id, offerAmount: '$20', offerStatus: 'pending' });
assert.strictEqual(db.ticketItems(bidder.id).length, 2, 're-bid stacks on the same ticket');
// The guard reads the newest offer, not the first one.
assert.strictEqual(db.findOpenTicketItem('offer', b.id, 'buyer9').offer_amount, '$20');
assert.deepStrictEqual(
  db.offerTicketsForListing(b.id).filter((o) => o.creator_id === 'buyer9').map((o) => `${o.offer_amount}/${o.offer_status}`),
  ['$20/pending', '$10/declined'],
  'both bids stay on record, newest first'
);

// The offer-again button routes back through the buyFlow handler.
const againButton = require('../src/services/listings').buildOfferAgainRow(b.id).toJSON().components[0];
assert.strictEqual(againButton.custom_id, `ls:again:${b.id}`);

// The picker only offers the user their own open tickets.
const mine = db.openTicketsForUser('buyer1').map((t) => t.id);
assert.deepStrictEqual(mine, [support.id]);

db.db.close();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmp}${suffix}`, { force: true });
console.log('ticket items: all checks passed');
