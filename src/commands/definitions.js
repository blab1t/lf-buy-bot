const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { WALLET_COINS } = require('../config');

const ADMIN = PermissionFlagsBits.Administrator;
const walletChoices = WALLET_COINS.map((coin) => ({ name: coin.label, value: coin.key }));

const definitions = [
  new SlashCommandBuilder()
    .setName('request')
    .setDescription('Post and manage account requests')
    .addSubcommand((sub) => sub.setName('create').setDescription('Post what account you are looking for')
      .addUserOption((o) => o.setName('owner').setDescription('Staff only: post on behalf of this buyer'))
      .addBooleanOption((o) => o.setName('ign-hidden').setDescription('Show Hidden instead of the title publicly'))
    )
    .addSubcommand((sub) =>
      sub.setName('edit').setDescription('Edit an existing request')
        .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('delete').setDescription('Delete a request')
        .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
        .addBooleanOption((o) => o.setName('local').setDescription('Delete only on this server, keep it on linked servers'))
    )
    .addSubcommand((sub) =>
      sub.setName('transfer').setDescription('Import an existing request channel and its TicketsBot ticket')
        .addChannelOption((o) => o.setName('proxy-channel').setDescription('Existing request/listing channel').setRequired(true))
        .addChannelOption((o) => o.setName('ticket-channel').setDescription('Existing TicketsBot ticket channel').setRequired(true))
        .addStringOption((o) => o.setName('ign').setDescription('Request title (defaults to the channel name)'))
        .addStringOption((o) => o.setName('category').setDescription('Existing category name or key (defaults to Other)'))
        .addUserOption((o) => o.setName('owner').setDescription('Buyer, only needed if it cannot be inferred from the ticket'))
        .addBooleanOption((o) => o.setName('ign-hidden').setDescription('Show Hidden instead of the title publicly'))
    )
    .addSubcommand((sub) =>
      sub.setName('reassign').setDescription('Move a request to a different buyer: close-requests the old ticket and opens a new one')
        .addStringOption((o) => o.setName('ign').setDescription('Title of the request').setRequired(true))
        .addUserOption((o) => o.setName('user').setDescription('New buyer').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('hide').setDescription('Hide (or reveal) the title on an existing request')
        .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
        .addBooleanOption((o) => o.setName('hidden').setDescription('True hides the title, false reveals it (default: true)'))
        .addBooleanOption((o) => o.setName('rename-channels').setDescription('Also rename the listing/ticket channels (default: true)'))
    )
    .addSubcommand((sub) => sub.setName('category-create').setDescription('Create a custom request category')
      .addStringOption((o) => o.setName('name').setDescription('Category name').setRequired(true).setMaxLength(50))
    )
    .addSubcommand((sub) => sub.setName('category-rename').setDescription('Rename a request category')
      .addStringOption((o) => o.setName('category').setDescription('Current category name or key').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('New category name').setRequired(true).setMaxLength(50))
    )
    .addSubcommand((sub) => sub.setName('category-list').setDescription('List all request categories'))
    .addSubcommand((sub) => sub.setName('category-delete').setDescription('Delete an unused custom request category')
      .addStringOption((o) => o.setName('category').setDescription('Category name or key').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('sold-category').setDescription('Use an existing category for fulfilled requests')
      .addChannelOption((o) => o.setName('category').setDescription('Existing Fulfilled Requests category').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    )
    .addSubcommand((sub) => sub.setName('organize').setDescription('Move known request channels and tickets into their categories')
      .addBooleanOption((o) => o.setName('permissions').setDescription('Also re-apply channel permissions (slow: Discord limits channel edits)'))
      .addBooleanOption((o) => o.setName('refresh-cards').setDescription('Also re-render every listing card (default: true)')))
    .addSubcommand((sub) => sub.setName('check').setDescription('Find broken requests: duplicates and stuck accepts'))
    .addSubcommand((sub) => sub.setName('publish').setDescription('Finish a request that got stuck half-accepted')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (leave empty to fix every stuck request)')))
    .addSubcommand((sub) => sub.setName('restore').setDescription('Put a fulfilled request back on the board')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
      .addStringOption((o) => o.setName('bin').setDescription('New budget (optional)'))
      .addStringOption((o) => o.setName('co').setDescription('New best offer, or "offer" to reset it (optional)')))
    .addSubcommand((sub) => sub.setName('refresh').setDescription('Re-render request cards with the current formatting and clear stale buttons')
      .addStringOption((o) => o.setName('ign').setDescription('Only this request (leave empty with all:true for every request)'))
      .addBooleanOption((o) => o.setName('all').setDescription('Refresh every request instead of one')))
    .addSubcommand((sub) => sub.setName('attach').setDescription('Create a request for an existing ticket in this bot')
      .addChannelOption((o) => o.setName('channel').setDescription('The ticket channel (defaults to this one)').addChannelTypes(ChannelType.GuildText))
      .addUserOption((o) => o.setName('owner').setDescription('Buyer (defaults to the ticket creator)'))
      .addChannelOption((o) => o.setName('listing-channel').setDescription('Reuse this existing channel for the request card').addChannelTypes(ChannelType.GuildText))),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post a panel in this channel')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption((o) =>
      o.setName('type').setDescription('Which panel').setRequired(true)
        .addChoices({ name: 'Request panel', value: 'proxy' }, { name: 'Ticket panel', value: 'tickets' })
    ),
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Ask the ticket creator to close this ticket')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption((o) =>
      o.setName('time').setDescription('Auto close after this long, e.g. 45m, 2h, 1d (default 24h)')
    )
    .addBooleanOption((o) => o.setName('force').setDescription('Close on the timer with no way for the creator to cancel'))
    .addBooleanOption((o) => o.setName('now').setDescription('Close the ticket immediately'))
    .addBooleanOption((o) => o.setName('keep-proxy').setDescription('Leave the connected request alone: do not fulfil, delete or remove its channel')),
  new SlashCommandBuilder()
    .setName('inactive')
    .setDescription('Close tickets automatically when nobody writes in them')
    .addSubcommand((sub) => sub.setName('set').setDescription('Watch this ticket quietly and act once nobody writes for a while')
      .addStringOption((o) => o.setName('time').setDescription('Inactivity window, e.g. 3d, 1w, 14d').setRequired(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Ticket channel (defaults to this one)').addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName('action').setDescription('What happens when the window ends (default: send the close request)').addChoices(
        { name: 'Send the normal close request', value: 'request' },
        { name: 'Forced close the creator cannot cancel', value: 'force' },
        { name: 'Close immediately, no prompt', value: 'now' },
      ))
      .addStringOption((o) => o.setName('close-time').setDescription('How long the close request waits, e.g. 12h, 2d (default 24h)'))
      .addBooleanOption((o) => o.setName('silent').setDescription('Only for action "now": close without any message (default: true)')))
    .addSubcommand((sub) => sub.setName('cancel').setDescription('Stop watching a ticket for inactivity')
      .addChannelOption((o) => o.setName('channel').setDescription('Ticket channel (defaults to this one)').addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName('all').setDescription('Cancel every inactivity watch instead')))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show tickets being watched and when they close')),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user to this ticket')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true)),
  new SlashCommandBuilder()
    .setName('crypto')
    .setDescription('Convert between crypto and cash, or show current prices')
    .addNumberOption((o) => o.setName('amount').setDescription('Amount to convert').setMinValue(0))
    .addStringOption((o) => o.setName('currency').setDescription('Currency of the amount: a coin (BTC, ETH, SOL, LTC) or cash (USD, EUR, GBP...)'))
    .addBooleanOption((o) => o.setName('hidden').setDescription('Send only to you (default: true)')),
  new SlashCommandBuilder()
    .setName('setwallet')
    .setDescription('Save one of your crypto addresses so it can be shown with /wallet')
    .addStringOption((o) => o.setName('coin').setDescription('Which coin').setRequired(true).addChoices(...walletChoices))
    .addStringOption((o) => o.setName('address').setDescription('Your wallet address for this coin').setRequired(true).setMaxLength(120)),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Show saved crypto addresses')
    .addUserOption((o) => o.setName('user').setDescription('Whose wallet to show (defaults to you)'))
    .addStringOption((o) => o.setName('coin').setDescription('Show only one coin').addChoices(...walletChoices))
    .addBooleanOption((o) => o.setName('hidden').setDescription('Send only to you (default: false)')),
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run giveaways')
    .addSubcommand((sub) => sub.setName('start').setDescription('Start a giveaway')
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('duration').setDescription('How long, e.g. 30m, 2h, 1d (leave blank for no timer; end with /giveaway end)'))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in (defaults to here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addUserOption((o) => o.setName('host').setDescription('Who is hosting this giveaway (defaults to you)'))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(50))
      .addRoleOption((o) => o.setName('required-role').setDescription('Only members with this role can enter'))
      .addIntegerOption((o) => o.setName('min-invites').setDescription('Minimum invites required to enter').setMinValue(1).setMaxValue(10000))
      .addIntegerOption((o) => o.setName('goal-invites').setDescription('Invite race: first entrant to this many invites since start wins').setMinValue(1).setMaxValue(10000)))
    .addSubcommand((sub) => sub.setName('end').setDescription('End a giveaway now and draw winners')
      .addStringOption((o) => o.setName('message').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand((sub) => sub.setName('reroll').setDescription('Draw new winners for an ended giveaway')
      .addStringOption((o) => o.setName('message').setDescription('Giveaway message ID').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('How many new winners (default: the original count)').setMinValue(1).setMaxValue(50)))
    .addSubcommand((sub) => sub.setName('cancel').setDescription('Cancel an active giveaway with no winner')
      .addStringOption((o) => o.setName('message').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('List active giveaways')),
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Invite counts and who invited whom')
    .addSubcommand((sub) => sub.setName('count').setDescription('Show how many invites someone has')
      .addUserOption((o) => o.setName('user').setDescription('Whose invites to show (defaults to you)')))
    .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Show the top inviters'))
    .addSubcommand((sub) => sub.setName('list').setDescription('List everyone a member invited')
      .addUserOption((o) => o.setName('user').setDescription('The inviter (defaults to you)'))
      .addBooleanOption((o) => o.setName('include-left').setDescription('Include members who left (default: true)')))
    .addSubcommand((sub) => sub.setName('who').setDescription('Show who invited a member')
      .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true)))
    .addSubcommand((sub) => sub.setName('all').setDescription('Show the full who-invited-whom list')),
  new SlashCommandBuilder()
    .setName('pingroles')
    .setDescription('Manage self-assignable ping/notification roles')
    .addSubcommand((sub) => sub.setName('post').setDescription('Post the ping-role panel (creates Giveaways + a role per category)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in (defaults to here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((sub) => sub.setName('add').setDescription('Add a custom ping role, e.g. Quicksells')
      .addStringOption((o) => o.setName('label').setDescription('Button label / role name').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji for the button (optional)'))
      .addRoleOption((o) => o.setName('role').setDescription('Use this existing role instead of creating one')))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Remove a ping role from the panel (keeps the Discord role)')
      .addRoleOption((o) => o.setName('role').setDescription('The ping role to remove').setRequired(true)))
    .addSubcommand((sub) => sub.setName('preview').setDescription('Preview the panel (only you see it) before posting'))
    .addSubcommand((sub) => sub.setName('list').setDescription('List the current ping roles')),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link this server with another so requests (by Minecraft UUID) stay in sync')
    .addSubcommand((sub) => sub.setName('add').setDescription('Link another server by its guild ID')
      .addStringOption((o) => o.setName('guild').setDescription("The other server's guild ID").setRequired(true)))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Unlink a server')
      .addStringOption((o) => o.setName('guild').setDescription("The other server's guild ID").setRequired(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show linked servers'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Re-push all local requests to linked servers now')),
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Build and post custom embeds, e.g. a fees notice')
    .addSubcommand((sub) => sub.setName('create').setDescription('Open the embed builder and post the result')
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (defaults to here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((sub) => sub.setName('edit').setDescription('Edit an embed this bot posted')
      .addStringOption((o) => o.setName('message').setDescription('Message ID or link of the embed').setRequired(true))),
  new SlashCommandBuilder()
    .setName('resendembed')
    .setDescription('Resend a message\'s embed and text as a fresh message')
    .addStringOption((o) => o.setName('message').setDescription('Message ID (this channel) or a message link').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('Where to resend it (defaults to here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder()
    .setName('role')
    .setDescription('Give a role to a user (or remove it)')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption((o) => o.setName('user').setDescription('Target user').setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
    .addBooleanOption((o) => o.setName('remove').setDescription('Remove the role instead of giving it')),
  new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Manage vouches')
    .setDefaultMemberPermissions(ADMIN)
    .addSubcommand((sub) => sub.setName('ping').setDescription('Ping a user in the vouches channel so they can leave a vouch')
      .addUserOption((o) => o.setName('user').setDescription('User to ping').setRequired(true)))
    .addSubcommand((sub) => sub.setName('add').setDescription('Record a message as a vouch (for screenshots or vouches that forgot to ping)')
      .addStringOption((o) => o.setName('message').setDescription('Link to the original vouch message').setRequired(true))
      .addUserOption((o) => o.setName('voucher').setDescription('User who left the vouch').setRequired(true))
      .addUserOption((o) => o.setName('vouched-for').setDescription('User who got vouched (gets the leaderboard credit)').setRequired(true))),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create or repair the server roles, channels and panels')
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Manage server verification')
    .addSubcommand((sub) => sub.setName('everyone').setDescription('Give the verified member role to every human member'))
    .addSubcommand((sub) => sub.setName('resend').setDescription('Post a new verification embed in the configured verify channel')),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Take over an existing TicketsBot ticket')
    .addSubcommand((sub) =>
      sub.setName('takeover').setDescription('Manage an existing TicketsBot ticket with this bot')
        .addChannelOption((o) => o.setName('channel').setDescription('Existing TicketsBot ticket channel').setRequired(true))
        .addUserOption((o) => o.setName('owner').setDescription('Ticket creator, if it cannot be inferred from channel permissions'))
        .addStringOption((o) => o.setName('type').setDescription('Ticket type').addChoices(
          { name: 'Support', value: 'support' }, { name: 'Sell', value: 'buy' },
          { name: 'Request', value: 'proxy' }, { name: 'Offer', value: 'offer' }
        ))
        .addChannelOption((o) => o.setName('listing-channel').setDescription('Requests only: reuse this existing channel for the request card').addChannelTypes(ChannelType.GuildText))
    )
    .addSubcommand((sub) =>
      sub.setName('rename').setDescription('Rename a ticket to this bot\'s naming scheme')
        .addChannelOption((o) => o.setName('channel').setDescription('Ticket channel (defaults to this one)').addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('name').setDescription('Custom base name (default: request title or ticket type)').setMaxLength(80))
    )
    .addSubcommand((sub) =>
      sub.setName('rename-all').setDescription('Rename every open managed ticket to this bot\'s scheme (slow, rate limited)')
    )
    .addSubcommand((sub) =>
      sub.setName('organize').setDescription('Move every open ticket into the category for its type')
        .addBooleanOption((o) => o.setName('permissions').setDescription('Also re-apply ticket permissions (slower)'))
    ),
  new SlashCommandBuilder()
    .setName('budget')
    .setDescription('Update the budget on a request')
    .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
    .addStringOption((o) => o.setName('amount').setDescription('New budget in USD, e.g. 250 - or "offer" to clear it').setRequired(true))
    .addBooleanOption((o) => o.setName('announce').setDescription('Post the change in the request channel (default: true)')),
  new SlashCommandBuilder()
    .setName('offer')
    .setDescription('Manage seller offers on a request')
    .addSubcommand((sub) => sub.setName('list').setDescription('Show seller offers on a request')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('set').setDescription('Set the best offer on a request by hand')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
      .addStringOption((o) => o.setName('amount').setDescription('New best offer in USD, e.g. 100 or $100').setRequired(true)))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Reset the best offer back to Offer')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('add').setDescription('Record an offer on behalf of a seller (reuses their old offer ticket)')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
      .addUserOption((o) => o.setName('buyer').setDescription('Which seller is offering').setRequired(true))
      .addStringOption((o) => o.setName('amount').setDescription('Offer in USD, e.g. 100 or $100').setRequired(true))
      .addBooleanOption((o) => o.setName('accept').setDescription('Accept it immediately and set it as the best offer (default: false)'))
      .addChannelOption((o) => o.setName('ticket').setDescription('Add it to this open ticket instead of the seller\'s offer ticket').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sub) => sub.setName('refresh').setDescription('Add the Offer again button to every open ticket that has an offer'))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Withdraw an offer ticket and optionally reset the best offer')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true))
      .addUserOption((o) => o.setName('buyer').setDescription('Which seller\'s offer to withdraw').setRequired(true))
      .addBooleanOption((o) => o.setName('reset-co').setDescription('Also reset the best offer to Offer (default: true)'))),
  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Find a request, its ticket or its channel')
    .addStringOption((o) => o.setName('query').setDescription('Request title, ticket number, channel link/ID, or part of a name').setRequired(true).setMaxLength(100))
    .addUserOption((o) => o.setName('user').setDescription('Only show requests and tickets involving this user')),
  new SlashCommandBuilder()
    .setName('angels')
    .setDescription('Mirror requests to the Angels API')
    .addSubcommand((sub) => sub.setName('status').setDescription('Show whether the Angels API mirror is active'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Push every published and fulfilled request to the Angels API'))
    .addSubcommand((sub) => sub.setName('add').setDescription('Push a single request now')
      .addStringOption((o) => o.setName('ign').setDescription('Request title (or the account it names)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Remove one request from the Angels API')
      .addStringOption((o) => o.setName('ign').setDescription('Account username (or use channel)'))
      .addChannelOption((o) => o.setName('channel').setDescription('Request channel to remove').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sub) => sub.setName('removeall').setDescription('Delete every Angels API listing for this key')),
  new SlashCommandBuilder()
    .setName('channelperms')
    .setDescription('Apply a standard permission preset to a channel')
    .addStringOption((o) => o.setName('preset').setDescription('Which access rules to apply').setRequired(true).addChoices(
      { name: 'Board - members read, staff post (request default)', value: 'listing' },
      { name: 'Chat - members can view and talk', value: 'chat' },
      { name: 'Announcement - members read only, staff post', value: 'announcement' },
      { name: 'Staff only - hidden from members', value: 'staff' },
      { name: 'Locked - visible to members, nobody but staff can post', value: 'locked' },
    ))
    .addChannelOption((o) => o.setName('channel').setDescription('Channel to change (defaults to here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory)),
  new SlashCommandBuilder()
    .setName('categories')
    .setDescription('Tell the bot which existing Discord categories to use')
    .addSubcommand((sub) => sub.setName('tickets').setDescription('Use an existing category for a ticket type')
      .addStringOption((o) => o.setName('type').setDescription('Which ticket type (offers share the buy category)').setRequired(true).addChoices(
        { name: 'Request tickets', value: 'proxy' }, { name: 'Seller offer tickets', value: 'buy' },
        { name: 'Support tickets', value: 'support' }
      ))
      .addChannelOption((o) => o.setName('category').setDescription('Existing category').setRequired(true).addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((sub) => sub.setName('listing').setDescription('Use an existing category for a request category\'s channels')
      .addStringOption((o) => o.setName('proxy-category').setDescription('Request category name or key, e.g. og').setRequired(true))
      .addChannelOption((o) => o.setName('category').setDescription('Existing category').setRequired(true).addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((sub) => sub.setName('sold').setDescription('Use an existing category for fulfilled requests')
      .addChannelOption((o) => o.setName('category').setDescription('Existing category').setRequired(true).addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show which categories the bot is using')),
  new SlashCommandBuilder()
    .setName('linkfilter')
    .setDescription('Block links from normal members, with an allowed-domain list')
    .addSubcommand((sub) => sub.setName('on').setDescription('Turn link blocking on'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn link blocking off'))
    .addSubcommand((sub) => sub.setName('allow').setDescription('Allow a domain, e.g. oguser.com')
      .addStringOption((o) => o.setName('domain').setDescription('Domain to allow').setRequired(true).setMaxLength(100)))
    .addSubcommand((sub) => sub.setName('disallow').setDescription('Remove a domain from the allow list')
      .addStringOption((o) => o.setName('domain').setDescription('Domain to remove').setRequired(true).setMaxLength(100)))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the filter status and allowed domains'))
    .addSubcommand((sub) => sub.setName('test').setDescription('Check what the filter would block in some text')
      .addStringOption((o) => o.setName('text').setDescription('Text to test').setRequired(true).setMaxLength(500))),
  new SlashCommandBuilder()
    .setName('logchannel')
    .setDescription('Set up the audit, message and transcript log channels')
    .addSubcommand((sub) => sub.setName('set').setDescription('Use an existing channel for one kind of log')
      .addStringOption((o) => o.setName('type').setDescription('Which log').setRequired(true).addChoices(
        { name: 'Audit log (bot actions)', value: 'audit' },
        { name: 'Message log (edits and deletions)', value: 'messages' },
        { name: 'Ticket transcripts', value: 'transcripts' },
      ))
      .addChannelOption((o) => o.setName('channel').setDescription('Target channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sub) => sub.setName('create').setDescription('Create a private staff channel for one kind of log')
      .addStringOption((o) => o.setName('type').setDescription('Which log').setRequired(true).addChoices(
        { name: 'Audit log (bot actions)', value: 'audit' },
        { name: 'Message log (edits and deletions)', value: 'messages' },
        { name: 'Ticket transcripts', value: 'transcripts' },
      ))
      .addStringOption((o) => o.setName('name').setDescription('Channel name (defaults per type)').setMaxLength(90)))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Stop writing one kind of log')
      .addStringOption((o) => o.setName('type').setDescription('Which log').setRequired(true).addChoices(
        { name: 'Audit log', value: 'audit' },
        { name: 'Message log', value: 'messages' },
        { name: 'Ticket transcripts', value: 'transcripts' },
      )))
    .addSubcommand((sub) => sub.setName('show').setDescription('Show all configured log channels')),
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Snapshots of requests, tickets and conversations stored on the host')
    .addSubcommand((sub) => sub.setName('now').setDescription('Take a backup right now'))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the snapshots kept on the host')),
  new SlashCommandBuilder()
    .setName('recover')
    .setDescription('Rebuild requests on a new server after losing the old one')
    .addSubcommand((sub) => sub.setName('preview').setDescription('Show what a rebuild would recreate'))
    .addSubcommand((sub) => sub.setName('rebuild').setDescription('Recreate request channels here, each with only a Finish button')
      .addBooleanOption((o) => o.setName('include-sold').setDescription('Also recreate fulfilled requests (default: false)')))
    .addSubcommand((sub) => sub.setName('dm-owners').setDescription('DM every buyer with a request, e.g. to invite them to the new server')
      .addStringOption((o) => o.setName('message').setDescription('What to tell them').setRequired(true).setMaxLength(1500))
      .addStringOption((o) => o.setName('invite').setDescription('Invite link to include'))
      .addBooleanOption((o) => o.setName('dry-run').setDescription('Only count recipients, send nothing'))),
  new SlashCommandBuilder()
    .setName('transcript')
    .setDescription('Save a transcript of a ticket without closing it')
    .addChannelOption((o) => o.setName('channel').setDescription('Ticket channel (defaults to this one)').addChannelTypes(ChannelType.GuildText))
    .addUserOption((o) => o.setName('dm').setDescription('Also DM the transcript to this user')),
];

// Commands that are also usable as a user-installed app (DMs and any server).
// These are registered globally instead of per-guild. In the configured server
// they stay Administrator-only via the runtime guard; in DMs there is no gate.
// integration_types: 0 = guild install, 1 = user install.
// contexts: 0 = guild, 1 = bot DM, 2 = private channel.
const DM_COMMANDS = new Set(['wallet', 'setwallet', 'crypto']);

// Commands normal members may run. Discord shows them to everyone; the runtime
// guard in index.js skips its Administrator check for these, and each handler
// gates its own staff-only subcommands (e.g. only /request create is open).
const MEMBER_COMMANDS = new Set(['request']);

// Discord hides every slash command from members who lack Administrator.
// The central interaction guard applies the same check at runtime.
const commandJson = definitions.map((d) => {
  const json = (MEMBER_COMMANDS.has(d.name) ? d : d.setDefaultMemberPermissions(ADMIN)).toJSON();
  if (DM_COMMANDS.has(json.name)) {
    json.integration_types = [0, 1];
    json.contexts = [0, 1, 2];
  }
  return json;
});

module.exports = commandJson;
module.exports.DM_COMMANDS = DM_COMMANDS;
module.exports.MEMBER_COMMANDS = MEMBER_COMMANDS;
