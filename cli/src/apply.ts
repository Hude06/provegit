import { diff_match_patch } from "diff-match-patch";

/** Owner run: `l` chars owned by envelope id `o`. A file's runs always sum to its length. */
export type Run = { l: number; o: string };
/** diff-match-patch ops: [0 keep | -1 delete | 1 insert, text]. */
export type Ops = [number, string][];

const dmp = new diff_match_patch();

export function charDiff(a: string, b: string): Ops {
  if (a === b) return a ? [[0, a]] : [];
  const ops = dmp.diff_main(a, b, false);
  // Minimal diffs keep stray single chars of replaced text ("r", "o"…), crediting rewritten code to its old owner.
  dmp.diff_cleanupSemantic(ops);
  return ops;
}

export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.l <= 0) continue;
    const last = out[out.length - 1];
    if (last && last.o === r.o) last.l += r.l;
    else out.push({ ...r });
  }
  return out;
}

/** Apply diff ops to owner runs: kept chars keep their owner, inserted chars go to `owner`. */
export function applyRuns(runs: Run[], ops: Ops, owner: string): Run[] {
  const out: Run[] = [];
  let ri = 0;
  let pos = 0;
  const consume = (n: number, keep: boolean) => {
    while (n > 0 && ri < runs.length) {
      const r = runs[ri];
      const m = Math.min(r.l - pos, n);
      if (keep) out.push({ l: m, o: r.o });
      n -= m;
      pos += m;
      if (pos >= r.l) {
        ri++;
        pos = 0;
      }
    }
    // Runs shorter than content (corrupt/legacy row): attribute the remainder to the editor.
    if (n > 0 && keep) out.push({ l: n, o: owner });
  };
  for (const [op, text] of ops) {
    if (op === 0) consume(text.length, true);
    else if (op === -1) consume(text.length, false);
    else out.push({ l: text.length, o: owner });
  }
  return mergeRuns(out);
}

export function runsLength(runs: Run[]): number {
  return runs.reduce((s, r) => s + r.l, 0);
}

/** Lines as an editor shows them: a trailing newline does not start an extra empty line. */
export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Owner per line (see splitLines) = owner of the most chars on that line; empty lines use their newline's owner. */
export function lineOwners(content: string, runs: Run[]): string[] {
  const owners: string[] = [];
  let ri = 0;
  let rpos = 0;
  const ownerAt = (): string => runs[ri]?.o ?? "unknown";
  const advance = () => {
    rpos++;
    while (ri < runs.length && rpos >= runs[ri].l) {
      ri++;
      rpos = 0;
    }
  };
  let counts = new Map<string, number>();
  for (let i = 0; i <= content.length; i++) {
    const end = i === content.length;
    if (end && i > 0 && content[i - 1] === "\n") break;
    if (end || content[i] === "\n") {
      let best = "";
      let bestN = 0;
      for (const [o, n] of counts) if (n > bestN) [best, bestN] = [o, n];
      owners.push(best || ownerAt());
      counts = new Map();
      if (!end) advance();
      continue;
    }
    const o = ownerAt();
    counts.set(o, (counts.get(o) ?? 0) + 1);
    advance();
  }
  return owners;
}

export function ownerStats(runs: Run[]): Map<string, number> {
  const s = new Map<string, number>();
  for (const r of runs) s.set(r.o, (s.get(r.o) ?? 0) + r.l);
  return s;
}

/** Replay ops against `cur`; returns the new content or undefined if ops don't match `cur` exactly. */
export function replay(cur: string, ops: Ops): string | undefined {
  let pos = 0;
  let next = "";
  for (const [op, text] of ops) {
    if (op === 1) {
      next += text;
      continue;
    }
    if (cur.slice(pos, pos + text.length) !== text) return undefined;
    if (op === 0) next += text;
    pos += text.length;
  }
  return pos === cur.length ? next : undefined;
}
