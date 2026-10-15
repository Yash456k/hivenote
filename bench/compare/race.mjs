// Race test: R rounds; each round creates one task and fires N concurrent
// `update_task {status:doing, claim:true}` requests from N distinct agents.
// Correct result: exactly one 200 and N-1 `taken` (409) per round.
// Usage: node race.mjs [rounds=1000] [agents=100]
import { call, createTask, uuid, now, stats, report } from './lib.mjs';

const ROUNDS = Number(process.argv[2] || 1000);
const N = Number(process.argv[3] || 100);
const tag = Date.now().toString(36);

let perfect = 0, multiWin = 0, zeroWin = 0, otherErrors = 0;
const claimMs = [];
const t0 = now();
for (let r = 0; r < ROUNDS; r++) {
  const name = `race-${tag}-${r}`;
  await createTask(name);
  const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
    const s = now();
    const res = await call('update_task', { note: name, status: 'doing', claim: true, op_id: uuid() }, `racer-${i}`);
    claimMs.push(now() - s);
    return res;
  }));
  const wins = results.filter(x => x.result).length;
  const taken = results.filter(x => x.error?.code === 'taken').length;
  otherErrors += N - wins - taken;
  if (wins === 1 && taken === N - 1) perfect++;
  else if (wins > 1) multiWin++;
  else if (wins === 0) zeroWin++;
  if ((r + 1) % 100 === 0) process.stderr.write(`round ${r + 1}/${ROUNDS}\n`);
}
report('race', {
  rounds: ROUNDS, agents_per_round: N, total_claims: ROUNDS * N,
  rounds_exactly_one_winner: perfect, rounds_multiple_winners: multiWin, rounds_no_winner: zeroWin,
  unexpected_errors: otherErrors, claim_latency_ms: stats(claimMs),
  wall_s: Math.round((now() - t0) / 100) / 10,
});
