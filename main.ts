// Werewolf agent for make.fun werewolf-agent-01 — pure heuristic, zero model calls.
// Plays 30 games/trial vs 7 house players. Deterministic: every choice is a function of the
// game's view and MAKEFUN_TRIAL_SEED. No wall clock, no Math.random().
// Strategy in short: track every vote/speech against revealed roles, score suspicion per seat,
// use private knowledge (seer results, wolf partner, doctor's last protect), push the top
// suspect in debate, vote with the evidence, and as a wolf match the partner's night vote so
// the kill always lands.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: number;
  target?: number | null;
  text?: string;
  died?: number | null;
  role?: string | null;
  tally?: { seat: number; votes: number }[];
  winner?: string | null;
  [k: string]: unknown;
}

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

interface View {
  day: number;
  phase: string;
  you: { seat: Seat; name: string; role: Role; alive: boolean; partner: { seat: Seat; name: string; alive: boolean } | null };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: number | null }[] | null;
  log: LogEntry[];
  outcome: { winner: string | null; reason: string; day: number; winners: number[] } | null;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

// ---------- deterministic randomness ----------

/** Seed from MAKEFUN_TRIAL_SEED + a salt: a stable uint32. */
function seed32(salt: string): number {
  const seed = process.env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';
  const h = createHash('sha256').update(`${seed}|${salt}`).digest();
  return h.readUInt32BE(0);
}

/** Deterministic pick among items: index from a seeded hash of the salt. */
function pickSeeded<T>(items: readonly T[], salt: string): T | null {
  if (items.length === 0) return null;
  return items[seed32(salt) % items.length]!;
}

/** Fold a statement to one line the env's way. */
function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

// ---------- per-game state ----------

interface GameState {
  view: View;
  me: Seat;
  myRole: Role;
  partner: Seat | null;
  alive: Seat[];
  dead: Map<Seat, string>; // seat -> revealed role
  nameOf: Map<Seat, string>;
  /** Suspicion per living seat (higher = more likely a wolf), village's view. */
  suspicion: Map<Seat, number>;
  /** Evidence strings per seat, for speech reasons. */
  evidence: Map<Seat, string[]>;
  /** Known wolves / known villagers from my seer results. */
  knownWolf: Set<Seat>;
  knownClear: Set<Seat>;
  /** How many speeches each seat made, and how many passes. */
  speeches: Map<Seat, number>;
  passes: Map<Seat, number>;
  /** Who each seat voted for, per day. */
  votesBy: Map<Seat, { day: number; target: number | null }[]>;
  /** Seats that claimed a role in speech (rough keyword scan). */
  claimedSeer: Set<Seat>;
  claimedDoctor: Set<Seat>;
  /** Current debate round (1 or 2), from the log. */
  round: number;
}

const WOLF_WORDS = /\b(wolf|werewolf|wolves)\b/i;
const SEER_CLAIM = /\b(i'?m|i am|me).{0,20}\bseer\b/i;
const DOCTOR_CLAIM = /\b(i'?m|i am|me).{0,20}\bdoctor\b/i;

/** Extract a seat number a speech accuses ("seat 5 is a wolf", "vote 5", "5 is the wolf"). */
function accusedSeat(text: string, names: Map<Seat, string>): Seat | null {
  const m = text.match(/\b(?:seat\s*)?([1-8])\b.{0,25}\b(?:wolf|werewolf)\b/i)
    ?? text.match(/\b(?:wolf|werewolf)\b.{0,25}\b(?:seat\s*)?([1-8])\b/i)
    ?? text.match(/\bvote\s+(?:for\s+)?(?:seat\s*)?([1-8])\b/i);
  if (m) return Number(m[1]);
  // By name: "X is a wolf" / "vote X"
  for (const [seat, name] of names) {
    const re = new RegExp(`\\b${name}\\b.{0,25}\\b(?:wolf|werewolf)\\b|\\bvote\\s+(?:for\\s+)?${name}\\b`, 'i');
    if (re.test(text)) return seat;
  }
  return null;
}

function buildState(view: View): GameState {
  const me = view.you.seat;
  const myRole = view.you.role;
  const partner = view.you.partner ? view.you.partner.seat : null;
  const nameOf = new Map<Seat, string>();
  const alive: Seat[] = [];
  const dead = new Map<Seat, string>();
  for (const p of view.players) {
    nameOf.set(p.seat, p.name);
    if (p.alive) alive.push(p.seat);
    else if (p.role) dead.set(p.seat, p.role);
  }
  const st: GameState = {
    view, me, myRole, partner, alive, dead, nameOf,
    suspicion: new Map(), evidence: new Map(), knownWolf: new Set(), knownClear: new Set(),
    speeches: new Map(), passes: new Map(), votesBy: new Map(),
    claimedSeer: new Set(), claimedDoctor: new Set(), round: 1,
  };
  for (const s of alive) {
    st.suspicion.set(s, 0);
    st.evidence.set(s, []);
    st.speeches.set(s, 0);
    st.passes.set(s, 0);
    st.votesBy.set(s, []);
  }
  const add = (seat: Seat, n: number, ev?: string) => {
    if (!st.suspicion.has(seat) || seat === me) return;
    st.suspicion.set(seat, (st.suspicion.get(seat) ?? 0) + n);
    if (ev) st.evidence.get(seat)!.push(ev);
  };

  // Private knowledge.
  if (view.seerResults) {
    for (const r of view.seerResults) {
      if (r.werewolf) { st.knownWolf.add(r.seat); add(r.seat, 100, 'checked as a wolf'); }
      else { st.knownClear.add(r.seat); add(r.seat, -100, 'checked clear'); }
    }
  }
  if (partner !== null) add(partner, -100, 'my partner');

  // Walk the public log.
  let maxRound = 1;
  for (const e of view.log) {
    if (e.kind === 'speech' && typeof e.seat === 'number' && typeof e.text === 'string') {
      const s = e.seat;
      if (st.speeches.has(s)) st.speeches.set(s, (st.speeches.get(s) ?? 0) + 1);
      if (typeof e.round === 'number') maxRound = Math.max(maxRound, e.round);
      if (SEER_CLAIM.test(e.text)) st.claimedSeer.add(s);
      if (DOCTOR_CLAIM.test(e.text)) st.claimedDoctor.add(s);
      // Accusations judged against what the accused turned out to be.
      const acc = accusedSeat(e.text, nameOf);
      if (acc !== null && dead.has(acc)) {
        const role = dead.get(acc)!;
        if (role === 'werewolf') add(s, -2, `called out ${nameOf.get(acc)} who was a wolf`);
        else add(s, 1.5, `pushed ${nameOf.get(acc)} who was ${role}`);
      } else if (acc !== null && s !== me) {
        // An unproven accusation: mild heat on the accuser on day 1 (wolves push early).
        if (view.day === 1) add(s, 0.6, 'pushed hard on day 1 with no evidence');
      }
      // Defending a revealed wolf is wolfish.
      if (dead.size > 0 && /defend|trust|not a wolf|innocent|clear/i.test(e.text)) {
        for (const [dseat, drole] of dead) {
          if (drole === 'werewolf' && e.text.toLowerCase().includes((nameOf.get(dseat) ?? '').toLowerCase())) {
            add(s, 1.5, `defended ${nameOf.get(dseat)} who was a wolf`);
          }
        }
      }
    } else if (e.kind === 'pass' && typeof e.seat === 'number') {
      if (st.passes.has(e.seat)) st.passes.set(e.seat, (st.passes.get(e.seat) ?? 0) + 1);
      add(e.seat, 0.4, 'stayed quiet');
    } else if (e.kind === 'vote' && typeof e.seat === 'number') {
      const t = typeof e.target === 'number' ? e.target : null;
      st.votesBy.get(e.seat)?.push({ day: e.day, target: t });
      if (t !== null && dead.has(t)) {
        const role = dead.get(t)!;
        if (role === 'werewolf') add(e.seat, -3, `voted to exile ${nameOf.get(t)} who was a wolf`);
        else add(e.seat, 2, `voted to exile ${nameOf.get(t)} who was ${role}`);
      }
    }
  }
  st.round = maxRound;

  // Quiet players look a little wolfish; chatterboxes a little less.
  for (const s of alive) {
    if (s === me) continue;
    const said = st.speeches.get(s) ?? 0;
    const passed = st.passes.get(s) ?? 0;
    if (view.day >= 2 && said === 0) add(s, 0.8, 'has said nothing');
    if (passed >= 2) add(s, 0.5, 'keeps passing');
  }
  return st;
}

/** Living seats other than me (and other than my wolf partner when I'm a wolf). */
function candidates(st: GameState, excludePartner: boolean): Seat[] {
  return st.alive.filter((s) => s !== st.me && !(excludePartner && st.myRole === 'werewolf' && s === st.partner));
}

/** Top suspect by suspicion; ties broken by seeded choice (stable per game/day/kind). */
function topSuspect(st: GameState, seats: Seat[], salt: string): Seat | null {
  if (seats.length === 0) return null;
  let best = -Infinity;
  let tied: Seat[] = [];
  for (const s of seats) {
    const v = st.suspicion.get(s) ?? 0;
    if (v > best) { best = v; tied = [s]; }
    else if (v === best) tied.push(s);
  }
  return pickSeeded(tied, `${salt}|${best}`);
}

/** Seeded fallback pick when there is no signal at all. */
function seededPick(st: GameState, seats: Seat[], salt: string): Seat | null {
  return pickSeeded(seats, salt);
}

// ---------- decisions ----------

/** Short reason for suspecting a seat, for speeches. */
function reasonFor(st: GameState, seat: Seat): string {
  const ev = st.evidence.get(seat) ?? [];
  const name = st.nameOf.get(seat) ?? `seat ${seat}`;
  if (st.knownWolf.has(seat)) return `${name} is a wolf — I checked them`;
  if (ev.length > 0) return ev[ev.length - 1]!;
  if ((st.passes.get(seat) ?? 0) > 0) return `${name} keeps passing instead of talking`;
  if ((st.speeches.get(seat) ?? 0) === 0) return `${name} has said nothing all game`;
  return `${name} doesn't add up to me`;
}

/** Threat score for a night kill target (wolf view): who hurts the wolves most. */
function threatOf(st: GameState, seat: Seat): number {
  let t = 0;
  const name = st.nameOf.get(seat) ?? '';
  // Accused me or my partner, or voted for us: dangerous.
  for (const [voter, votes] of st.votesBy) {
    if (voter !== seat) continue;
    for (const v of votes) {
      if (v.target === st.me || v.target === st.partner) t += 2;
    }
  }
  for (const e of st.view.log) {
    if (e.kind === 'speech' && e.seat === seat && typeof e.text === 'string') {
      if (e.text.toLowerCase().includes((st.nameOf.get(st.me) ?? '').toLowerCase())) t += 1;
      if (st.partner !== null && e.text.toLowerCase().includes((st.nameOf.get(st.partner) ?? '').toLowerCase())) t += 1;
      if (WOLF_WORDS.test(e.text)) t += 0.5; // talks about wolves a lot
    }
  }
  if (st.claimedSeer.has(seat)) t += 4; // a claimed seer is the top kill
  if ((st.suspicion.get(seat) ?? 0) < -1) t += 1.5; // accurate accuser
  t += (st.speeches.get(seat) ?? 0) * 0.2; // talkative players steer the village
  // Don't waste a kill on someone the village is about to exile anyway.
  t -= Math.max(0, st.suspicion.get(seat) ?? 0) * 0.4;
  void name;
  return t;
}

/** Value score for a protect target (doctor view): who would the wolves kill tonight. */
function protectValueOf(st: GameState, seat: Seat): number {
  let v = 0;
  if (st.claimedSeer.has(seat)) v += 5; // wolves hunt a claimed seer
  if ((st.suspicion.get(seat) ?? 0) < -1) v += 2; // accurate accuser
  v += (st.speeches.get(seat) ?? 0) * 0.3;
  if ((st.speeches.get(seat) ?? 0) === 0) v -= 1; // quiet players are rarely the kill
  return v;
}

function decideKill(st: GameState, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  // Coordinate: if my partner already named someone tonight, match them — a split
  // vote kills nobody.
  const night = st.view.day;
  const partnerVote = st.view.wolfVotes?.find((v) => v.night === night && v.seat === st.partner && v.target !== null);
  if (partnerVote && options.includes(partnerVote.target!)) return partnerVote.target!;
  let best = -Infinity;
  let tied: Seat[] = [];
  for (const s of options) {
    const t = threatOf(st, s);
    if (t > best) { best = t; tied = [s]; }
    else if (t === best) tied.push(s);
  }
  return pickSeeded(tied, `kill|${st.view.day}|${best}`);
}

function decideProtect(st: GameState, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  let best = -Infinity;
  let tied: Seat[] = [];
  for (const s of options) {
    const v = protectValueOf(st, s);
    if (v > best) { best = v; tied = [s]; }
    else if (v === best) tied.push(s);
  }
  return pickSeeded(tied, `protect|${st.view.day}|${best}`);
}

function decideInspect(st: GameState, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  // Inspect the most suspicious living seat; with no signal, the quietest one.
  const top = topSuspect(st, options, `inspect|${st.view.day}`);
  if (top !== null && (st.suspicion.get(top) ?? 0) > 0) return top;
  let quietest: Seat[] = [];
  let min = Infinity;
  for (const s of options) {
    const n = st.speeches.get(s) ?? 0;
    if (n < min) { min = n; quietest = [s]; }
    else if (n === min) quietest.push(s);
  }
  return pickSeeded(quietest, `inspect-quiet|${st.view.day}`);
}

function decideVote(st: GameState, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  if (st.myRole === 'werewolf') {
    // Bandwagon with the village: vote the top suspect among non-wolves, never the partner.
    const pool = options.filter((s) => s !== st.partner);
    const top = topSuspect(st, pool, `vote-wolf|${st.view.day}`);
    if (top !== null && (st.suspicion.get(top) ?? 0) > 0.5) return top;
    // No clear village target: vote a seeded villager-looking seat to blend in.
    return seededPick(pool, `vote-wolf-blend|${st.view.day}`);
  }
  const top = topSuspect(st, options, `vote|${st.view.day}`);
  if (top !== null && (st.suspicion.get(top) ?? 0) > 0.5) return top;
  // Weak read: help the village reach a plurality instead of splitting the vote.
  // Count today's votes already cast and join the biggest wagon.
  const tally = new Map<Seat, number>();
  for (const e of st.view.log) {
    if (e.kind === 'vote' && e.day === st.view.day && typeof e.target === 'number' && options.includes(e.target)) {
      tally.set(e.target, (tally.get(e.target) ?? 0) + 1);
    }
  }
  let wagon: Seat | null = null;
  let wagonVotes = 0;
  for (const [seat, n] of tally) {
    if (n > wagonVotes) { wagonVotes = n; wagon = seat; }
  }
  if (wagon !== null && wagonVotes >= 2) return wagon;
  // Day 1 with no evidence: abstain rather than throw a random vote.
  if (st.view.day === 1) return null;
  return seededPick(options, `vote-fallback|${st.view.day}`);
}

function decideSpeak(st: GameState, maxChars: number): string | null {
  const name = (s: Seat) => st.nameOf.get(s) ?? `seat ${s}`;
  const round = st.round;
  const day = st.view.day;

  if (st.myRole === 'werewolf') {
    const pool = candidates(st, true);
    const top = topSuspect(st, pool, `speak-wolf|${day}|${round}`);
    const target = top !== null && (st.suspicion.get(top) ?? 0) > 0 ? top : seededPick(pool, `speak-wolf-target|${day}|${round}`);
    // If the village is pushing my partner, deflect gently.
    const partnerHeat = st.partner !== null ? (st.suspicion.get(st.partner) ?? 0) : -100;
    if (st.partner !== null && partnerHeat > 1 && round === 2) {
      const alt = target !== null && target !== st.partner ? target : null;
      const line = alt !== null
        ? `I'm not convinced on ${name(st.partner)}. ${name(alt)} looks worse to me — ${reasonFor(st, alt)}.`
        : `I'm not convinced on ${name(st.partner)} — nothing they said reads wolf to me.`;
      return foldStatement(line).slice(0, maxChars);
    }
    if (target === null) return null;
    const lines = [
      `${name(target)} is my pick today. ${reasonFor(st, target)}.`,
      `I keep coming back to ${name(target)}. ${reasonFor(st, target)}.`,
      `Watching ${name(target)} — ${reasonFor(st, target)}. What do the rest of you think?`,
    ];
    if (round === 1 && day === 1) {
      return foldStatement(`No strong read yet. ${name(target)} felt a bit off to me, but it's early — let's hear everyone.`).slice(0, maxChars);
    }
    return foldStatement(pickSeeded(lines, `speak-wolf-line|${day}|${round}`)!).slice(0, maxChars);
  }

  // Village side.
  if (st.myRole === 'seer' && st.knownWolf.size > 0) {
    const wolf = [...st.knownWolf].filter((s) => st.alive.includes(s))[0];
    if (wolf !== undefined) {
      return foldStatement(`I checked ${name(wolf)} last night. They are a werewolf. Vote ${name(wolf)} today — this is a confirmed check, not a guess.`).slice(0, maxChars);
    }
  }
  const pool = candidates(st, false);
  const top = topSuspect(st, pool, `speak|${day}|${round}`);
  if (top !== null && (st.suspicion.get(top) ?? 0) > 0.5) {
    const lines = [
      `${name(top)} is my pick today. ${reasonFor(st, top)}.`,
      `The case on ${name(top)} is the strongest I see. ${reasonFor(st, top)}.`,
      `I'm voting ${name(top)}. ${reasonFor(st, top)}.`,
    ];
    return foldStatement(pickSeeded(lines, `speak-line|${day}|${round}`)!).slice(0, maxChars);
  }
  if (st.myRole === 'seer' && st.knownClear.size > 0) {
    const clear = [...st.knownClear].filter((s) => st.alive.includes(s))[0];
    if (clear !== undefined && round === 1) {
      return foldStatement(`${name(clear)} is clear as far as I'm concerned. Let's look elsewhere today.`).slice(0, maxChars);
    }
  }
  if (day === 1 && round === 1) {
    return foldStatement(`No strong read yet — first day, no deaths to learn from. I'll listen and watch the votes.`).slice(0, maxChars);
  }
  // Nothing solid: say something light so the village can read me as engaged.
  const talkers = pool.filter((s) => (st.speeches.get(s) ?? 0) > 0);
  const quiet = pool.filter((s) => (st.speeches.get(s) ?? 0) === 0);
  if (quiet.length > 0 && round === 1) {
    return foldStatement(`${name(quiet[0]!)} has barely spoken. Quiet isn't proof, but I want to hear from them before we vote.`).slice(0, maxChars);
  }
  if (talkers.length > 0) {
    return foldStatement(`Still weighing it up. Nobody has a clean case yet — I'll vote on the strongest read when the time comes.`).slice(0, maxChars);
  }
  return null;
}

function decide(p: Pending): { game: number; decision: DecisionKind; target?: Seat | null; text?: string; pass?: boolean } {
  const st = buildState(p.view);
  const options = p.options ?? [];
  switch (p.decision) {
    case 'kill': return { game: p.game, decision: 'kill', target: decideKill(st, options) };
    case 'protect': return { game: p.game, decision: 'protect', target: decideProtect(st, options) };
    case 'inspect': return { game: p.game, decision: 'inspect', target: decideInspect(st, options) };
    case 'vote': return { game: p.game, decision: 'vote', target: decideVote(st, options) };
    case 'speak': {
      const text = decideSpeak(st, p.max_chars ?? 500);
      if (text === null || text === '') return { game: p.game, decision: 'speak', pass: true };
      return { game: p.game, decision: 'speak', text };
    }
  }
}

// ---------- main loop ----------

const CONCURRENCY = 10;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  // The brief is read for protocol faithfulness; decisions use the view + seed only.
  try {
    if (process.env.MAKEFUN_PROMPT_FILE) readFileSync(process.env.MAKEFUN_PROMPT_FILE, 'utf8');
  } catch { /* brief unreadable: the view carries everything needed */ }

  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try { parsed = JSON.parse(await res.text()); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };

  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${p.view.log.length}`;
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();
  let decisions = 0;

  for (;;) {
    const r = await post('/observe', {});
    if (r.status !== 200 || r.body === null || typeof r.body !== 'object') throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;
      started.add(key);
      const task = (async () => {
        decisions += 1;
        const act = decide(p);
        let posted = await post('/act', act);
        if (posted.status !== 200) {
          const fallback = p.decision === 'speak'
            ? { game: p.game, decision: 'speak', pass: true }
            : { game: p.game, decision: p.decision, target: null };
          posted = await post('/act', fallback);
        }
        if (posted.status !== 200) throw new Error(`POST /act answered ${posted.status} for game ${p.game} ${p.decision}`);
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }
    const waiting = obs.pending.some((p) => !started.has(keyOf(p)));
    if (inFlight.size > 0 && (inFlight.size >= CONCURRENCY || !waiting)) await Promise.race(inFlight.values());
    else if (inFlight.size === 0 && obs.pending.length > 0 && !waiting) await sleep(250);
  }
  await Promise.all(inFlight.values());
  process.stdout.write(`werewolf-agent: ${decisions} decisions answered, all games finished\n`);
}

try {
  await main();
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
}
