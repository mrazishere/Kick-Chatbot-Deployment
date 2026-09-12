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

import { pendingRedemptionsFromApi, pendingVerdict, parseTargetUsername } from '../channels/reward-redemptions';

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

console.log(`\n[rewards-selftest] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
