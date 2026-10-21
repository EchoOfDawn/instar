## What Changed

- **A promise with a date can now actually carry one.** `POST /commitments` accepts `checkInAt` — the field the dated-reminder feature reads — and stores it on the commitment. Until now the field was silently discarded: the request returned 201, and the stored record had no date. Four places in the code read `checkInAt` (the beacon's trigger resolution, the dated-backlog filter, and both arms of `GET /commitments/check-in-reminder`); none of them could ever have matched anything, which is why that route honestly reported `datedCount: 0` across every commitment on the agent.
- **A bare date is refused rather than quietly resolved.** `2026-10-24` is a valid timestamp to a parser and means midnight UTC — so a check-in promised for "Friday" would have fired at 5pm Thursday for anyone in Pacific time. The request is refused with the reason and an example of the right shape, instead of being resolved to an hour nobody chose.
- **A date alone does not count as follow-through.** Creating a commitment still requires either PromiseBeacon enrollment with a deadline, or an explicit opt-out reason. A dated check-in rides alongside those; it does not replace them, because the reconciler that posts the dated reminder still ships in observation mode and would send nothing.

## What to Tell Your User

If your agent promised you something "by Friday", the date it was given could not be stored, so nothing was ever going to arrive on Friday. The date is now recorded.

Be aware of the honest scope: recording the date is one half. The part that actually posts the reminder when the moment arrives still ships switched off pending a deliberate decision, so this is not yet "a dated promise always produces a reminder". What changed is that the promise can now hold its date at all — previously the whole feature had no way in.

## Summary of New Capabilities

- `POST /commitments` accepts and stores `checkInAt`, an absolute instant, with a bare date refused by name.

## Evidence

- **Before.** `checkInAt` appears four times in `src/server/routes.ts` as a READ (`commitment.checkInAt` in the beacon trigger, `all.filter(c => !!c.checkInAt)` in the dated backlog, and twice in the reminder route's response) and was declared in `CommitmentTracker.record()`'s input type **zero** times. A live commitment created on 2026-10-21 with `checkInAt` set returned HTTP 200 and the field was absent from the stored record's keys; `GET /commitments/check-in-reminder` reported `datedCount: 0` against 883 commitments.
- **After.** The field is stored, survives a re-read from a fresh tracker over the same state directory, and is matched by the same filter the reminder route applies. A bare date returns 400 naming "bare date"; a non-timestamp returns 400 naming ISO 8601; a date with no other follow-through choice returns 400 naming the follow-through requirement.
- `tests/unit/CommitmentTracker-checkinat-writer.test.ts` (5 tests) and `tests/integration/commitments-checkinat-route.test.ts` (8 tests) pass.
