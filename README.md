# Werewolf agent — make.fun `werewolf-agent-01`

A pure-heuristic Werewolf player. **Zero model calls** — every decision is computed
from the game's view and `MAKEFUN_TRIAL_SEED`, so the entry is fully deterministic
and replay-safe (no wall clock, no unseeded randomness).

## How it plays

- **Suspicion model.** Every seat carries a score built from the public log, judged
  against revealed roles: voting to exile a revealed villager +2, voting out a
  revealed wolf −3, pushing a revealed villager +1.5, calling out a revealed wolf
  −2, defending a revealed wolf +1.5, passing +0.4, staying silent +0.8. Seer
  results override everything (known wolf +100, known clear −100); the wolf
  partner is never suspected.
- **Night, as a werewolf.** Match the partner's vote when they already named
  someone (a split vote kills nobody); otherwise kill the highest-threat living
  non-wolf: accusers/voters of me or my partner, claimed seers, accurate
  accusers, talkative players — never someone the village is about to exile.
- **Night, as doctor.** Protect the likeliest wolf target: claimed seers first,
  then accurate accusers and talkative players (never self, never last night's
  protect).
- **Night, as seer.** Inspect the most suspicious living seat; with no signal,
  the quietest one. A found wolf is revealed in debate at once.
- **Day debate.** Short evidence-citing statements (always under 500 chars):
  wolves blend in, push villagers and deflect heat off the partner; villagers
  push the top suspect with reasons; the seer names a checked wolf outright.
- **Day vote.** Village side votes the top suspect; with only a weak read it
  joins the biggest existing wagon so the village reaches a plurality instead
  of splitting; day 1 with no evidence it abstains. Wolf side bandwagons with
  the village and never votes the partner.

## Run

Runs as `node /bot/main.ts` (Node 22, standard library only). It loops
`POST /observe` → decides every pending decision → `POST /act`, up to 10
decisions in flight, and exits once the trial reports `done`.

## Local grades (practice instances, vs a deterministic dummy house lane)

The kit's `grade-local` needs a real Anthropic/OpenAI key for the house players,
which this entry does not have, so trials were run against the kit's own env
server (`program/env/server.mjs`) with a local stand-in house that plays legal
but generic moves. These numbers measure the agent against a *passive* house,
not against claude-haiku-5-5 — treat them as an end-to-end sanity check, not a
prediction of the real score.

| trial | score | wolf | village | seer | doctor | villager | vote acc. |
|-------|-------|------|---------|------|--------|----------|-----------|
| 0     | 667   | 933  | 400     | 600  | 200    | 400      | 400       |
| 1     | 467   | 733  | 200     | 200  | 0      | 400      | 478       |
| 2     | 467   | 867  | 67      | 200  | 0      | 0        | 297       |

Mean 534. All 30/30 games finished in every trial, 0 house retries, 0 fallbacks,
0 house errors. Two runs of trial 0 produced byte-identical `state.json`
(replay-safe). Wolf side is consistently strong; village side is the weak side
against a house that gives no readable signal — the real house (an LLM that
accuses, defends and slips) gives the suspicion model far more to read.
