# LF Buy Bot (discordShopBotV3)

A Discord bot that runs a **wanted board**: members post the Minecraft account
they are *looking for*, staff approve it, and sellers answer with offers. It is
the inverse of the V2 shop bot, which listed accounts sellers wanted to proxy.

The bot also manages the rest of the server: verification, tickets, vouches,
giveaways, invites, ping roles, link filtering, logs, transcripts and backups.

## Before starting

1. `npm install` (Node 20+).
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `GUILD_ID` and `OWNER_ID`.
3. Invite the bot with Administrator (or at least Manage Channels, Manage Roles,
   Manage Messages, Read Message History, Send Messages, Embed Links, Attach Files,
   Manage Server for invite tracking).
4. `npm start`, then run `/setup` in the server.

`STAFF_ROLE_ID` may be left empty: until it is set, only Administrators and
`OWNER_ID` count as staff. `/setup` creates a **Staff** role and tells you the ID
to paste into `.env`.

## How a deal works

1. A member presses **Create Request** (or runs `/request create`) and gets one
   modal straight away: what kind of thing it is (typed, not picked from a menu),
   a short title, a description, a budget (`100` or a range `50-100`) and how
   many they want. A kind the bot does not know is filed under **Other** with the
   buyer's own wording kept on the card. Account-shaped requests then pick the
   capes the account should ideally have; every request finishes with the detail
   fields for its kind (see below). If anything is rejected, **Edit again**
   reopens the modal with everything still filled in.
2. The bot opens a private request ticket and pings staff.
3. Staff press **Accept**, name the request channel, and press **Finish**. The
   request card is published on the board.
4. Sellers press **Offer an account** (account + asking price) or **Sell at
   budget**. Each offer opens a seller ticket and waits for staff approval.
5. An accepted offer becomes the request's **Best offer** and is announced on the
   card. Undercut sellers are told without learning who undercut them.
6. When the buyer has their account, **Mark Fulfilled** moves the request into the
   Fulfilled Requests category.

## Setup creates

- Roles: Member, Customer (and Staff when `STAFF_ROLE_ID` is empty).
- Channels: `verify`, `tickets`, `requests`, `vouches-<count>`, plus the community
  channels `announcements`, `partners`, `telegram`, `chat`, `botspam`, `giveaways`
  and `dndw`. Channels that already exist are adopted, never recreated or wiped.
- Categories: **General** (the community channels are moved under it), Request Tickets,
  Seller Offers, Support Tickets, Fulfilled Requests, and one per request kind.

## What can be requested

| Kind | Detail fields it asks for |
|---|---|
| Minecraft Accounts | ranks/NWL, stats, incidents, payment, other |
| Names | type of name, name changes, incidents, payment, other |
| Cape Accounts | specific capes, how many capes, name changes, incidents, other |
| Cape Codes | specific capes/codes, how many, payment, incidents, other |
| Minecon | name changes, capes, incidents, payment, other |
| Quicksells | bulk terms, stats, ranks, payment, other |
| Discord Accounts | account age, badges/Nitro, handle, incidents, other |
| Discord Servers | members, niche, vanity, incidents, other |
| YouTube Channels | subscribers, niche, handle, incidents, other |
| Social Accounts | followers, niche, handle, incidents, other |
| Gaming Accounts | platform/game, stats, incidents, payment, other |
| Other | platform, payment, incidents, other |

Every kind also carries the shared basics: title, description, budget range and
amount. Detail fields are paragraph boxes, so requirements can be written out in
full. An amount of 0 or 1 is not shown on the card, and the **Best offer** line
only appears once a seller's offer has been accepted. Staff can add more kinds
with `/request category-create`.

## Commands

| Command | Access | What it does |
|---|---|---|
| `/request create` | everyone | Post what account you are looking for. |
| `/request edit`, `delete`, `reassign`, `restore`, `refresh`, `publish`, `check`, `attach`, `transfer` | staff | Manage requests on the board. |
| `/request category-*`, `sold-category`, `organize` | staff | Manage request categories and channel layout. |
| `/offer list/set/clear/add/remove/refresh` | staff | Manage seller offers on a request. |
| `/budget` | staff | Change a request's budget. |
| `/panel`, `/setup`, `/verify`, `/close`, `/inactive`, `/add`, `/role`, `/vouch`, `/ticket` | staff | Panels, setup, tickets and vouches. |
| `/giveaway`, `/invites`, `/pingroles`, `/embed`, `/resendembed` | staff | Community tooling. |
| `/linkfilter`, `/logchannel`, `/channelperms`, `/categories`, `/backup`, `/recover`, `/transcript`, `/find`, `/link`, `/angels` | staff | Moderation, logging and data tools. |
| `/crypto`, `/wallet`, `/setwallet` | staff (DM-installable) | Crypto prices and saved wallet addresses. |

## Data

SQLite at `data/bot.db` (override with `DB_PATH`). Back it up to keep requests,
tickets and vouch history. Nightly snapshots are written by the backup service.

## Tests

```bash
npm test
```
