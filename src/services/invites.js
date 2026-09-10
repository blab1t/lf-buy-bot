const db = require('../db');

// code -> { inviterId, uses }. Single-guild bot, so one cache is enough.
let cache = new Map();
let vanityUses = 0;
let tracking = false;

function snapshot(invites) {
  const next = new Map();
  for (const invite of invites.values()) {
    next.set(invite.code, { inviterId: invite.inviter ? invite.inviter.id : null, uses: invite.uses || 0 });
  }
  return next;
}

// Reads every invite once so later joins can be diffed. Requires the bot to
// have the Manage Server permission; without it this degrades gracefully and
// invite-based giveaway features simply stay inactive.
async function prime(guild) {
  try {
    cache = snapshot(await guild.invites.fetch());
    if (guild.vanityURLCode) {
      const vanity = await guild.fetchVanityData().catch(() => null);
      vanityUses = vanity ? vanity.uses : 0;
    }
    tracking = true;
    return true;
  } catch (err) {
    tracking = false;
    console.error('Invite tracking is off (the bot likely lacks the Manage Server permission):', err.message);
    return false;
  }
}

function onInviteCreate(invite) {
  cache.set(invite.code, { inviterId: invite.inviter ? invite.inviter.id : null, uses: invite.uses || 0 });
}
function onInviteDelete(invite) {
  cache.delete(invite.code);
}

// Credits whichever invite's use count grew when a member joined. Returns the
// crediting inviter id, or null when it cannot be determined.
async function onMemberAdd(member) {
  if (member.user.bot || !tracking) return null;
  const guild = member.guild;
  let inviterId = null;
  try {
    const invites = await guild.invites.fetch();
    for (const invite of invites.values()) {
      const previous = cache.get(invite.code);
      if ((invite.uses || 0) > (previous ? previous.uses : 0)) {
        inviterId = invite.inviter ? invite.inviter.id : null;
      }
    }
    cache = snapshot(invites);
    if (!inviterId && guild.vanityURLCode) {
      const vanity = await guild.fetchVanityData().catch(() => null);
      if (vanity && vanity.uses > vanityUses) {
        vanityUses = vanity.uses;
        inviterId = 'vanity';
      }
    }
  } catch (err) {
    return null;
  }
  if (inviterId && inviterId !== 'vanity') {
    db.recordInvitedMember(member.id, inviterId, Date.now());
    db.incrementInvite(inviterId, 1);
  }
  return inviterId;
}

// Removes the credit when an invited member leaves, so counts reflect members
// who actually stayed.
function onMemberRemove(member) {
  const record = db.getInvitedMember(member.id);
  if (record && record.active) {
    db.deactivateInvitedMember(member.id);
    db.incrementInvite(record.inviter_id, -1);
  }
}

function getInviteCount(userId) {
  return db.getInviteCount(userId);
}
function invitesSince(userId, sinceTs) {
  return db.countInvitesSince(userId, sinceTs);
}
function isTracking() {
  return tracking;
}

module.exports = {
  prime, onInviteCreate, onInviteDelete, onMemberAdd, onMemberRemove,
  getInviteCount, invitesSince, isTracking,
};
