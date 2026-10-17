import type { FishOverlayEvent, PublicFishing } from "./bot-api";
import { botNow } from "./overlay-clock";

/**
 * The overlay's demo (?demo=1): replies rolled the way the bot rolls them, at the
 * channel's own odds, so a preview shows what a stream really sees — mostly empty
 * casts. Mirrors the bot's fish command: a cast lands a fish 1 in catchOdds, a miss
 * snags junk 1 in 4; traps roll once a minute for 75–90% of their time.
 */
export type DemoOdds = Pick<PublicFishing, "catchOdds" | "fish" | "junk" | "steal"> & {
  /** Overrides the share of steals, for reviewing them (?steals=1). */
  stealShare?: number;
};

/** Where the channel's odds can't be read: the bot's defaults, roughly. */
const FALLBACK: DemoOdds = {
  catchOdds: 20,
  fish: [
    { emoji: "🐟", chance: 17, rarity: "Common", price: 25 },
    { emoji: "🦐", chance: 17, rarity: "Common", price: 25 },
    { emoji: "🦀", chance: 17, rarity: "Common", price: 25 },
    { emoji: "🐸", chance: 17, rarity: "Common", price: 25 },
    { emoji: "🐠", chance: 11, rarity: "Uncommon", price: 60 },
    { emoji: "🐡", chance: 11, rarity: "Uncommon", price: 60 },
    { emoji: "🦑", chance: 4, rarity: "Rare", price: 150 },
    { emoji: "🐙", chance: 4, rarity: "Rare", price: 150 },
    { emoji: "🦈", chance: 1.4, rarity: "Epic", price: 400 },
    { emoji: "🐋", chance: 0.3, rarity: "Legendary", price: 1500 },
  ],
  junk: [
    { emoji: "🌿", chance: 50, rarity: "Common", price: 2 },
    { emoji: "🍂", chance: 25, rarity: "Common", price: 1 },
    { emoji: "🧦", chance: 13, rarity: "Common", price: 5 },
    { emoji: "🥫", chance: 11, rarity: "Common", price: 5 },
    { emoji: "🥾", chance: 1, rarity: "Rare", price: 20 },
  ],
};

/** A trap haul's share of replies: 400 of 1,102 in sukasblood, 22–29 Sep 2026. */
const TRAP_SHARE = 0.36;
/** Where the channel has stealing on, this share of replies are steals. No real data yet: a guess. */
const STEAL_SHARE = 0.05;
/** The bot's default success chance by rarity. */
const STEAL_ODDS: Record<string, number> = { Common: 40, Uncommon: 30, Rare: 20, Epic: 10, Legendary: 5 };

/** The bot's defaults; the public odds don't carry them. */
const TRAP_MINUTES = 60;
const CATCH_COOLDOWN_MINUTES = 30;

const NAMES = ["ReelDeal", "Kayla_Fishes", "Sn1perSam", "FishyBiz", "noodle_rider", "mochiii", "bigtuna88", "CastAway", "TideTurner", "LuckyLure"];
const SAD = ["sadE", "Sadge", "PepeHands", "SAJ", "docnotL"];
const HAPPY = ["PogU", "LETSGO", "PagMan", "WICKED"];
const JUNK_MESSAGES = [
  "Oops! You snagged something that's better off in the garbage.",
  "Oh dear, it looks like you've reeled in some unwanted clutter.",
  "It seems luck wasn't on your side this time. You caught a piece of junk.",
  "You've landed a piece of useless debris.",
  "You pull up something disappointing.",
  "Ah... just another item for the scrap heap.",
  "Wow! Would you look at that! ...nevermind, it's just junk.",
  "Your line gets tangled up in some junk.",
];

const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

function weighted(list: DemoOdds["fish"]): DemoOdds["fish"][number] {
  const total = list.reduce((s, c) => s + c.chance, 0);
  let r = Math.random() * total;
  for (const c of list) if ((r -= c.chance) < 0) return c;
  return list[list.length - 1];
}

/** Half price at 1 cm, full at 50, double at 100, as the bot prices a fish. */
function sizeMultiplier(cm: number): number {
  return cm <= 50 ? 0.5 + (0.5 * (cm - 1)) / 49 : 1 + (cm - 50) / 50;
}

export function demoGenerator(odds: DemoOdds | null) {
  const o = odds && odds.fish.some((f) => f.chance > 0) && odds.junk.length ? odds : FALLBACK;
  const fish = o.fish.filter((f) => f.chance > 0);
  const oneIn = Math.max(1, o.catchOdds);
  /** Each demo angler's casts since their last fish, for the bot's "attempt #n" line. */
  const dry = new Map<string, number>();

  function cast(name: string): Omit<FishOverlayEvent, "id" | "ts" | "username"> {
    if (Math.random() < 1 / oneIn) {
      dry.set(name, 0);
      const f = weighted(fish);
      const cm = int(1, 100);
      const worth = Math.round(f.price * sizeMultiplier(cm)).toLocaleString("en-US");
      return {
        kind: "catch",
        item: f.emoji,
        rarity: f.rarity,
        text: `You caught a ✨${f.emoji}✨ It is ${cm} cm in length. Worth ${worth} $DON. ${pick(HAPPY)} Now, go do something productive! (${CATCH_COOLDOWN_MINUTES} minute fishing cooldown after a successful catch)`,
      };
    }
    const streak = (dry.get(name) ?? int(0, 15)) + 1;
    dry.set(name, streak);
    const secs = Math.round(int(30_000, 90_000) / 1000);
    const wait = secs < 60 ? `${secs}s` : "1m";
    const what = Math.random() < 0.25 ? `${pick(JUNK_MESSAGES)} You reel out a ${weighted(o.junk).emoji}` : `Your fishing line landed ${int(1, 500)} cm away.`;
    const tail = streak >= 3 ? ` This is your attempt #${streak} since your last catch.` : "";
    return { kind: "miss", text: `No luck... ${pick(SAD)} ${what} (${wait} cooldown)${tail}` };
  }

  function trap(): Omit<FishOverlayEvent, "id" | "ts" | "username"> {
    const rolls = Math.floor((TRAP_MINUTES * int(75, 90)) / 100);
    const haul: string[] = [];
    let fishes = 0;
    for (let i = 0; i < rolls; i++) {
      if (Math.random() < 1 / oneIn) {
        // A fish costs a catch cooldown of the trap's time, so only an early one counts.
        if (i < rolls - CATCH_COOLDOWN_MINUTES) {
          fishes++;
          i += CATCH_COOLDOWN_MINUTES;
          haul.push(weighted(fish).emoji);
        }
      } else if (Math.random() < 0.25) {
        haul.push(weighted(o.junk).emoji);
      }
    }
    const lead = "You drag the traps out of the water...";
    if (!haul.length) return { kind: "trap", text: `${lead} and find that there is nothing at all...!` };
    return { kind: "trap", text: fishes ? `${lead} and you spot some fish! ${haul.join("")}` : `${lead} and find a bunch of junk. ${haul.join("")}` };
  }

  function steal(name: string): Omit<FishOverlayEvent, "id" | "ts" | "username"> {
    const victim = pick(NAMES.filter((n) => n !== name));
    const f = weighted(fish);
    const cm = int(1, 100);
    const worth = Math.round(f.price * sizeMultiplier(cm));
    // The bot's defaults: a 3% fee, and a fine set from the odds for a 20% thief's edge.
    const p = (STEAL_ODDS[f.rarity] ?? 0) / 100;
    const feeN = Math.max(10, Math.round(worth * 0.03));
    const fee = feeN.toLocaleString("en-US");
    if (Math.random() < p) {
      return {
        kind: "steal",
        item: f.emoji,
        rarity: f.rarity,
        text: `🪝 You snuck up on @${victim} and made off with their ✨${f.emoji}✨ (${cm} cm), worth ${worth.toLocaleString("en-US")} $DON! (${fee} $DON fee, ${int(0, 2)} tries left on your hook, ${CATCH_COOLDOWN_MINUTES}m cooldown)`,
      };
    }
    const fine = Math.max(25, Math.round((p * worth * 1.2 - feeN) / (1 - p))).toLocaleString("en-US");
    return {
      kind: "caught",
      item: f.emoji,
      rarity: f.rarity,
      text: `🚨 @${victim} caught you red-handed reaching for their ✨${f.emoji}✨! You paid a ${fine} $DON fine on top of the ${fee} $DON fee. (${int(0, 2)} tries left on your 🪝 hook, ${CATCH_COOLDOWN_MINUTES}m cooldown)`,
    };
  }

  /** `n` replies from different anglers, newest id first as a poll would hand them over. */
  return function burst(startId: number, n = NAMES.length): FishOverlayEvent[] {
    const now = Date.now();
    return NAMES.slice(0, n).map((username, i) => ({
      ...(o.steal && Math.random() < (odds?.stealShare ?? STEAL_SHARE) ? steal(username) : Math.random() < TRAP_SHARE ? trap() : cast(username)),
      id: startId - i,
      ts: now,
      username,
    }));
  };
}

const TROPHIES = ["🦭", "🦦", "🦕", "💎", "👑", "🐉"];

/**
 * A big bite for the demo, as the bot plays one: the first code, two more pulls
 * with codes that flash and hide, then the trophy landed (or, 1 time in 4, the
 * line snapping). Each step comes with how long after the start it happens;
 * `at` is called when a step is due, so the codes' deadlines are right then.
 */
export function demoBigBite(startId: number): Array<{ afterMs: number; at: () => FishOverlayEvent }> {
  // Not one of the burst's anglers: a reply to the same viewer would end their code card early.
  const username = "TheBigOne";
  const code = () => String(int(10, 99));
  const trophy = pick(TROPHIES);
  const step = (i: number, ev: () => Omit<FishOverlayEvent, "id" | "ts" | "username">) => () => ({ ...ev(), id: startId - i, ts: botNow(), username });
  const landed = Math.random() < 0.75;
  return [
    { afterMs: 0, at: step(0, () => ({ kind: "bite", code: code(), pull: 1, pulls: 3, until: botNow() + 12_000, text: "🎣 Something BIG is tugging at your line! Reel it in with $don fish reel <code> within 30s! (3 pulls)" })) },
    { afterMs: 7_000, at: step(1, () => ({ kind: "bite", code: code(), pull: 2, pulls: 3, until: botNow() + 8_000, flashMs: 3_000, text: "💪 Got it! It's pulling back hard! Quick, a new code flashes on stream: type just the code within 8s! (pull 2/3)" })) },
    { afterMs: 12_000, at: step(2, () => ({ kind: "bite", code: code(), pull: 3, pulls: 3, until: botNow() + 8_000, flashMs: 3_000, text: "💪 Got it! It's pulling back hard! Quick, a new code flashes on stream: type just the code within 8s! (pull 3/3)" })) },
    {
      afterMs: 17_000,
      at: step(3, () => landed
        ? { kind: "catch", item: trophy, rarity: "Mythic", text: `🏆 You reeled it in! A MYTHIC ✨${trophy}✨! It is ${int(1, 100)} cm in length. Worth 1,000 $DON.` }
        : { kind: "miss", item: trophy, rarity: "Mythic", text: `So close! It was a ✨${trophy}✨! It thrashed free on the last pull and snapped the line! 😱` }),
    },
  ];
}
