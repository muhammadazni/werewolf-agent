# Build log — Werewolf agent sprint (2026-11-12, ~01:13–01:25 WIB)

## What was built
- `main.ts` — heuristic Werewolf agent, Node 22 stdlib only, zero model calls,
  deterministic (seeded from `MAKEFUN_TRIAL_SEED`, no clock, no `Math.random`).
  Written in 2 passes (initial write + 1 revision adding the day-vote bandwagon).
- `LICENSE` — MIT (copied from the kit's `starter/LICENSE`).
- `.makefun/owner.json` — `{"wallet": "36gnE3GYfU5RrhbWA3t8rwattQHKtiPB2MUF8Ei6Hb9D"}`
  (the agent wallet connected to @muhammadazni).
- `README.md` — strategy + local grades.

## Protocol source
- Kit downloaded from `https://make.fun/c/werewolf-agent-01/kit` (5.2 MB).
- Protocol read from `RULES.txt` + `practice/trial-0/input/prompt.txt` + the
  kit's `starter/main.ts` (observe/act loop shape reused, model call replaced
  by heuristic logic). No guessing: env routes, view/log shapes, decision
  kinds, 500-char statement rule, determinism rule all taken from the kit.

## Local grading (practice instances, kit env server + dummy house lane)
`grade-local` could NOT be used: it refuses a live trial without a real
Anthropic/OpenAI key (the house players need one), and no such key exists.
Instead the kit's own env server (`program/env/server.mjs`) was run directly
with a local stand-in house lane (`test/house-lane.mjs`, NOT part of the repo)
that answers every house decision legally but generically (fixed statements,
seeded picks). The kit's own scorer (`program/scorer/score.mjs`) scored the
exported state. Results:

| trial | score | wolf | village | seer | doctor | villager | vote acc. | finished |
|-------|-------|------|---------|------|--------|----------|-----------|----------|
| 0     | 667   | 933  | 400     | 600  | 200    | 400      | 400       | 30/30    |
| 1     | 467   | 733  | 200     | 200  | 0      | 400      | 478       | 30/30    |
| 2     | 467   | 867  | 67      | 200  | 0      | 0        | 297       | 30/30    |

Mean 534. Trial 0 re-run twice → byte-identical `state.json` (replay-safe).
Honest read: these numbers are vs a PASSIVE house, not claude-haiku-5-5, so
they do NOT predict the real score and do NOT compare to the 367 baseline
(claude-opus-5-5 vs the real house). Wolf side strong (733–933); village side
weak (67–400) because a dummy house gives no readable signal — the real LLM
house will. The agent never crashed, never stalled a game, 0 fallbacks.

## Files
- Repo (ready to commit): `~/workspace/makefun-werewolf/repo/` — main.ts
  (22,054 B), LICENSE, .makefun/owner.json, README.md, BUILD_LOG.md.
- Kit: `~/workspace/makefun-werewolf/werewolf-agent-01-kit/` (do NOT submit).
- Test harness (not part of the repo): `~/workspace/makefun-werewolf/test/`
  (house-lane.mjs, run-trial.sh). Logs: `/tmp/wolf-scores-{0,1,2}/scores.json`,
  `/tmp/wolf-state-{0,1,2}/export/state.json`.

## Remaining steps (parent)
1. Create a NEW public GitHub repo under **muhammadazni** (created after
   11 Nov 02:00), OSI license (MIT file is in the repo), push this commit.
2. Bundle the build transcripts (`node cli/makefun.mjs bundle --repo <repo>` —
   this session is the build session, inside the competition window).
3. `node cli/makefun.mjs check --kit <kit> --repo <repo> --transcripts transcripts.tar.gz`.
4. Submit with the connected agent wallet (API key at
   `~/workspace/makefun/.api-key.json`, handle verified muhammadazni).
   NOTE: standing authorization recorded 2026-11-12 ~01:20 WIB allows
   confirming/filing bounty entries directly without waiting for Sadut to read
   the draft first (does NOT cover selling assets, paid mints, or swaps).
5. Deadline: **Thu 12 Nov 2026 02:00 WIB sharp** — last submission before it
   is the final entry.
