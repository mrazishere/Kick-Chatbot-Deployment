/**
 * Reward reconciliation selftest: the pure parts of catching a redemption whose
 * webhook Kick never delivered.
 *
 *   npx tsx src/tools/rewards-selftest.ts
 *
 * The sample payload is the real one Kick returned for sukasblood on
 * 2026-09-12, when Cyturn's redemption sat pending with no webhook.
 * Exits non-zero when any check fails.
 */

import {
  pendingRedemptionsFromApi, pendingVerdict, parseTargetUsername,
  rewardsFromApi, pauseTargetIds, pauseDecisions
} from '../channels/reward-redemptions';
import { RewardAction } from '../types';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const MIN = 60_000;

// Kick's real response, shape and all.
const real = {
  data: [
    {
      reward: {
        id: '01M0W8PBR3GYQGPDV61MB1S865',
        title: 'Timeout someone 120 seconds',
        cost: 10000,
        description: 'Someone talking too much?',
        can_manage: true
      },
      redemptions: [
        {
          id: '01M2972JNJGFPJ6D5Z3ZY8R2KN',
          user_input: 'NutellaBiscuits',
          status: 'pending',
          redeemed_at: '2026-09-11T21:48:13Z',
          redeemer: { user_id: 66181816 }
        }
      ]
    }
  ],
  message: 'OK',
  pagination: { next_cursor: '' }
};

const rows = pendingRedemptionsFromApi(real);
check('the real payload yields one redemption', rows.length === 1, rows);
check('redemption id, target and redeemer are read',
  rows[0]?.id === '01M2972JNJGFPJ6D5Z3ZY8R2KN' &&
  rows[0]?.userInput === 'NutellaBiscuits' &&
  rows[0]?.redeemerId === 66181816, rows[0]);
check('the reward is carried down to each redemption',
  rows[0]?.rewardId === '01M0W8PBR3GYQGPDV61MB1S865' &&
  rows[0]?.rewardTitle === 'Timeout someone 120 seconds' &&
  rows[0]?.rewardCost === 10000, rows[0]);
check('the target name parses out of the input', parseTargetUsername(rows[0]?.userInput) === 'NutellaBiscuits');

// Anything unrecognisable is dropped, never guessed at.
check('no data is no rows', pendingRedemptionsFromApi({}).length === 0 && pendingRedemptionsFromApi(null).length === 0);
check('a non-array data is no rows', pendingRedemptionsFromApi({ data: 'nope' }).length === 0);
check('a reward with no redemptions is skipped',
  pendingRedemptionsFromApi({ data: [{ reward: { id: 'r1', title: 't' } }] }).length === 0);
check('a row with no id is skipped',
  pendingRedemptionsFromApi({ data: [{ reward: { id: 'r1', title: 't' }, redemptions: [{ user_input: 'x' }] }] }).length === 0);
check('an already-resolved row is skipped',
  pendingRedemptionsFromApi({
    data: [{ reward: { id: 'r1', title: 't' }, redemptions: [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'pending' }] }]
  }).map(r => r.id).join(',') === 'b');
check('a missing redeemer leaves id 0, not NaN',
  pendingRedemptionsFromApi({ data: [{ reward: { id: 'r1', title: 't' }, redemptions: [{ id: 'a' }] }] })[0]?.redeemerId === 0);
check('several rewards each keep their own redemptions',
  pendingRedemptionsFromApi({
    data: [
      { reward: { id: 'r1', title: 'one' }, redemptions: [{ id: 'a', redeemer: { user_id: 1 } }] },
      { reward: { id: 'r2', title: 'two' }, redemptions: [{ id: 'b', redeemer: { user_id: 2 } }, { id: 'c', redeemer: { user_id: 3 } }] }
    ]
  }).map(r => `${r.rewardTitle}:${r.id}`).join(',') === 'one:a,two:b,two:c');

// Recent enough to carry out, or refund.
const now = Date.parse('2026-09-12T00:00:00Z');
check('a redemption from a minute ago is acted on',
  pendingVerdict('2026-09-11T23:59:00Z', now, 10 * MIN) === 'act');
check('a redemption at the age limit is still acted on',
  pendingVerdict('2026-09-11T23:50:00Z', now, 10 * MIN) === 'act');
check('an hour-old redemption is refunded',
  pendingVerdict('2026-09-11T23:00:00Z', now, 10 * MIN) === 'refund');
check('an unknown timestamp is refunded, never fired blind',
  pendingVerdict(null, now, 10 * MIN) === 'refund' && pendingVerdict('not a date', now, 10 * MIN) === 'refund');
check("Cyturn's stuck redemption would have been refunded, not acted on",
  pendingVerdict(rows[0]?.redeemedAt ?? null, Date.parse('2026-09-11T22:48:13Z'), 10 * MIN) === 'refund');

// ─── Pausing the bot's rewards while the channel is offline ──────────────────

const rewardList = {
  data: [
    { id: 'roulette', title: 'Huat or Kena', is_enabled: true, is_paused: false },
    { id: 'timeout', title: 'Timeout someone 120 seconds', is_enabled: true, is_paused: false },
    { id: 'streamer-paused', title: 'VEE EYE PEE', is_enabled: true, is_paused: true },
    { id: 'disabled', title: 'Date night', is_enabled: false, is_paused: false }
  ]
};
const rewards = rewardsFromApi(rewardList);
check('rewards parse with their paused and enabled flags',
  rewards.length === 4 && rewards[0].isPaused === false && rewards[2].isPaused === true && rewards[3].isEnabled === false, rewards);
check('a reward with no id is dropped', rewardsFromApi({ data: [{ title: 'x' }] }).length === 0);

const actions = [
  { rewardId: 'roulette', action: 'roulette', durationSeconds: 60 },
  { rewardId: 'timeout', action: 'timeout', durationSeconds: 120 }
] as RewardAction[];
check('both configured rewards follow the stream', pauseTargetIds(actions).join(',') === 'roulette,timeout');
check('an action can opt out',
  pauseTargetIds([{ rewardId: 'roulette', action: 'roulette', durationSeconds: 60, pauseWhenOffline: false }] as RewardAction[]).length === 0);
check('an action matched only by title is left alone',
  pauseTargetIds([{ rewardTitle: 'Huat', action: 'roulette', durationSeconds: 60 }] as RewardAction[]).length === 0);

const targets = pauseTargetIds(actions);
const offline = pauseDecisions({ targets, rewards, pausedByBot: [], isLive: false });
check('going offline pauses both configured rewards',
  offline.toPause.join(',') === 'roulette,timeout' && offline.toResume.length === 0, offline);
check('nothing outside the configured rewards is touched',
  !offline.toPause.includes('streamer-paused') && !offline.toPause.includes('disabled'), offline);

const alreadyPaused = pauseDecisions({
  targets,
  rewards: rewardsFromApi({ data: [{ id: 'roulette', is_enabled: true, is_paused: true }, { id: 'timeout', is_enabled: true, is_paused: false }] }),
  pausedByBot: ['roulette'],
  isLive: false
});
check('a reward already paused is not paused again', alreadyPaused.toPause.join(',') === 'timeout', alreadyPaused);

const live = pauseDecisions({
  targets,
  rewards: rewardsFromApi({ data: [{ id: 'roulette', is_enabled: true, is_paused: true }, { id: 'timeout', is_enabled: true, is_paused: true }] }),
  pausedByBot: ['roulette'],
  isLive: true
});
check('going live resumes only what the bot paused', live.toResume.join(',') === 'roulette' && live.toPause.length === 0, live);
check("a reward the streamer paused is never resumed",
  pauseDecisions({ targets, rewards, pausedByBot: [], isLive: true }).toResume.length === 0);
check('a reward the bot paused that someone already resumed is dropped quietly',
  pauseDecisions({
    targets,
    rewards: rewardsFromApi({ data: [{ id: 'roulette', is_enabled: true, is_paused: false }] }),
    pausedByBot: ['roulette'],
    isLive: true
  }).toResume.length === 0);

console.log(`\n[rewards-selftest] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
