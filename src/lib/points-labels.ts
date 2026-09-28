/**
 * How ledger reasons read in a viewer's $DON history. Shared by the admin
 * dashboard and the public leaderboard, so both say the same thing.
 */

export const COUNTERPARTY_PREFIX: Record<string, string> = {
  give_out: "to",
  give_in: "from",
  "game:duel_hold": "vs",
  "game:duel_stake": "vs",
  "game:duel_win": "beat",
  "game:duel_refund": "vs",
};

export const REASON_LABEL: Record<string, string> = {
  follow: "Follow bonus",
  sub_new: "New sub",
  sub_renewal: "Resub",
  gift_sub: "Gifted subs",
  gift_recv: "Received a gifted sub",
  kicks: "Kicks",
  give_out: "Gave",
  give_in: "Received",
  mod_add: "Added by mod",
  mod_remove: "Removed by mod",
  mod_set: "Set by mod",
  dash_add: "Added in dashboard",
  dash_remove: "Removed in dashboard",
  dash_set: "Set in dashboard",
  dash_reset: "Channel reset",
  pusher_sub: "Sub",
  "game:gamble": "Gamble bet",
  "game:gamble_win": "Gamble win",
  "game:duel_hold": "Duel challenge (held)",
  "game:duel_stake": "Duel accepted (stake)",
  "game:duel_win": "Duel win",
  "game:duel_refund": "Duel refund",
  "game:raffle_win": "Raffle win",
  "game:fish": "Fishing cast",
  "game:fish_win": "Fishing catch",
  "game:fish_bait": "Fishing bait",
  "game:fish_sell": "Sold fish",
  "game:fish_reel": "Bought a reel",
  "game:fish_reel_refund": "Reel taken back, refunded",
  channel_points: "Bought with channel points",
  channel_points_reversal: "Channel points refunded, taken back",
  "game:slots": "Slots bet",
  "game:slots_win": "Slots win",
  cookie: "Daily cookie",
};
