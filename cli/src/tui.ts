import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { Ops } from "./apply.js";
import { Actor, Changes, EditEvent, FileChange } from "./changes.js";
import { Store } from "./store.js";
import type { Row } from "./ui.js";
import { watch } from "./watch.js";

/* ───────────────────────── colour ───────────────────────── */

type RGB = [number, number, number];

function oklch(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }) as RGB;
}

const hex = (s: string): RGB => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;

const TRUECOLOR =
  /truecolor|24bit/i.test(process.env.COLORTERM ?? "") ||
  ["iTerm.app", "WezTerm", "ghostty", "vscode", "Hyper"].includes(process.env.TERM_PROGRAM ?? "");

function to256([r, g, b]: RGB): number {
  const lv = [0, 95, 135, 175, 215, 255];
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const [cr, cg, cb] = [q(r), q(g), q(b)];
  const cubeD = (r - lv[cr]) ** 2 + (g - lv[cg]) ** 2 + (b - lv[cb]) ** 2;
  const gi = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + gi * 10;
  const grayD = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return grayD < cubeD ? 232 + gi : 16 + 36 * cr + 6 * cg + cb;
}

const fg = (c: RGB) => (TRUECOLOR ? `38;2;${c.join(";")}` : `38;5;${to256(c)}`);
const bg = (c: RGB) => (TRUECOLOR ? `48;2;${c.join(";")}` : `48;5;${to256(c)}`);
const join = (...p: (string | false | undefined)[]) => p.filter(Boolean).join(";");

type Theme = {
  dark: boolean;
  muted: string;
  faint: string;
  accent: string;
  sel: string;
  rule: string;
  live: string;
  delRow: string;
  delWash: string;
  delText: string;
  addText: string;
  human: { rib: string; wash: string; row: string };
  agent: (hue: number) => { rib: string; wash: string; row: string };
};

function makeTheme(dark: boolean): Theme {
  return dark
    ? {
        dark,
        muted: fg(hex("#8B96A6")),
        faint: fg(hex("#4A5468")),
        accent: fg(hex("#8CA6FF")),
        sel: bg(hex("#2B3550")),
        rule: fg(hex("#3A4356")),
        live: fg(oklch(0.72, 0.16, 150)),
        delRow: bg(hex("#2C1F24")),
        delWash: bg(hex("#4A2730")),
        delText: fg(hex("#E7A1AC")),
        addText: fg(hex("#9BD6A8")),
        human: { rib: fg(hex("#8E99AA")), wash: bg(hex("#3A4254")), row: bg(hex("#21262F")) },
        agent: (h) => ({ rib: fg(oklch(0.74, 0.15, h)), wash: bg(oklch(0.37, 0.085, h)), row: bg(oklch(0.24, 0.032, h)) }),
      }
    : {
        dark,
        muted: fg(hex("#667180")),
        faint: fg(hex("#B4BCC8")),
        accent: fg(hex("#3559C7")),
        sel: bg(hex("#DCE3F2")),
        rule: fg(hex("#D6DCE3")),
        live: fg(oklch(0.58, 0.16, 150)),
        delRow: bg(hex("#FDF1F3")),
        delWash: bg(hex("#F6CDD3")),
        delText: fg(hex("#8A3B47")),
        addText: fg(hex("#2F7A45")),
        human: { rib: fg(hex("#5E6878")), wash: bg(hex("#DDE2E8")), row: bg(hex("#F3F5F7")) },
        agent: (h) => ({ rib: fg(oklch(0.58, 0.17, h)), wash: bg(oklch(0.915, 0.07, h)), row: bg(oklch(0.97, 0.022, h)) }),
      };
}

function detectDark(): boolean {
  const t = process.env.PROV_THEME;
  if (t === "light") return false;
  if (t === "dark") return true;
  // COLORFGBG="fg;bg" (rxvt, iTerm, Konsole…): bg 7 or 15 = light background.
  const bgc = Number((process.env.COLORFGBG ?? "").split(";").pop());
  return !(bgc === 7 || bgc === 15);
}

let T = makeTheme(true);

/** Same hue scheme as the web viewer: harness picks the hue, model/effort nudge it. */
const HUE: Record<string, number> = { claude: 292, codex: 172, opencode: 62 };
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

type Ink = { rib: string; wash: string; row: string; label: string; human: boolean; known: boolean };

function inkOf(id: string, actors: Record<string, Actor>): Ink {
  const a = actors[id];
  if (!a) return { ...T.human, rib: T.muted, row: "", label: "not recorded", human: false, known: false };
  const label = a.label.replace(/^agent:/, "");
  if (a.kind === "human") return { ...T.human, label, human: true, known: true };
  const base = HUE[a.harness ?? ""] ?? hash(a.harness ?? "") % 360;
  const shift = ((hash((a.model ?? "") + "@" + (a.effort ?? "")) % 3) - 1) * 18;
  return { ...T.agent((base + shift + 360) % 360), label, human: false, known: true };
}

/* ───────────────────────── text cells ───────────────────────── */

export type Span = { t: string; s?: string };

/** Terminal cell width of a code point (0 for combining marks, 2 for wide CJK/emoji). */
export function cpWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  )
    return 2;
  return 1;
}

export const width = (s: string) => {
  let w = 0;
  for (const ch of s) w += cpWidth(ch.codePointAt(0)!);
  return w;
};

/** Make file text safe to print: tabs → spaces, control chars (incl. ESC) → visible pictures. */
export function clean(s: string, col = 0): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\t") {
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else if (cp < 32) {
      out += String.fromCodePoint(0x2400 + cp);
      col++;
    } else if (cp === 0x7f) {
      out += "␡";
      col++;
    } else if (cp >= 0x80 && cp < 0xa0) {
      out += "�";
      col++;
    } else {
      out += ch;
      col += cpWidth(cp);
    }
  }
  return out;
}

/** Clean every span with a running column so tab stops line up across spans. */
function cleanSpans(spans: Span[]): Span[] {
  let col = 0;
  return spans.map((sp) => {
    const t = clean(sp.t, col);
    col += width(t);
    return { ...sp, t };
  });
}

/** Wrap spans (already clean) into lines of at most `w` cells. */
export function wrap(spans: Span[], w: number): Span[][] {
  const lines: Span[][] = [[]];
  let col = 0;
  for (const sp of spans) {
    let buf = "";
    for (const ch of sp.t) {
      const cw = cpWidth(ch.codePointAt(0)!);
      if (col + cw > w && col > 0) {
        if (buf) lines[lines.length - 1].push({ t: buf, s: sp.s });
        lines.push([]);
        buf = "";
        col = 0;
      }
      buf += ch;
      col += cw;
    }
    if (buf) lines[lines.length - 1].push({ t: buf, s: sp.s });
  }
  return lines;
}

/** Render spans into exactly `w` cells over row style `fill`; overlong text ends in "…". */
function fit(spans: Span[], w: number, fill = ""): string {
  let out = "";
  let col = 0;
  const total = spans.reduce((n, sp) => n + width(sp.t), 0);
  const limit = total > w ? w - 1 : w;
  for (const sp of spans) {
    if (col >= limit) break;
    let t = "";
    for (const ch of sp.t) {
      const cw = cpWidth(ch.codePointAt(0)!);
      if (col + cw > limit) break;
      t += ch;
      col += cw;
    }
    if (t) out += `\x1b[0;${join(fill, sp.s)}m${t}`;
  }
  if (total > w) {
    out += `\x1b[0;${join(fill, T.muted)}m…`;
    col++;
  }
  return out + `\x1b[0;${fill}m${" ".repeat(Math.max(0, w - col))}\x1b[0m`;
}

/** Keep the tail of a path (the filename matters most) within `w` cells. */
function tailFit(s: string, w: number): string {
  if (width(s) <= w) return s;
  const chars = [...s];
  let out = "";
  let n = 1;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = cpWidth(chars[i].codePointAt(0)!);
    if (n + cw > w) break;
    out = chars[i] + out;
    n += cw;
  }
  return "…" + out;
}

/* ───────────────────────── diff documents ───────────────────────── */

/** One logical line of the diff pane; wrapped to the pane width at render time. */
type DocLine = {
  num: [string, string];
  sign: string;
  rib: string;
  body: Span[];
  fill: string;
  hunk?: boolean;
  fold?: number;
};
export type Doc = { lines: DocLine[]; numW: number };

const CTX = 3;

/** Which rows to show: changed rows ± CTX lines, unless `whole`. */
function keepMask(changed: boolean[], whole: boolean): boolean[] {
  const keep = new Array(changed.length).fill(whole);
  if (!whole)
    changed.forEach((c, i) => {
      if (c) for (let j = Math.max(0, i - CTX); j <= Math.min(changed.length - 1, i + CTX); j++) keep[j] = true;
    });
  return keep;
}

function foldLine(n: number, numW: number): DocLine {
  return { num: ["", ""], sign: " ", rib: "", body: [{ t: `⋯ ${n} unchanged line${n === 1 ? "" : "s"}`, s: T.muted }], fill: "", fold: n };
}

function folded(all: DocLine[], changed: boolean[], whole: boolean, numW: number): DocLine[] {
  const keep = keepMask(changed, whole);
  const out: DocLine[] = [];
  for (let i = 0; i < all.length; ) {
    if (keep[i]) {
      const line = all[i];
      if (changed[i] && (i === 0 || !changed[i - 1])) line.hunk = true;
      out.push(line);
      i++;
      continue;
    }
    let j = i;
    while (j < all.length && !keep[j]) j++;
    out.push(foldLine(j - i, numW));
    i = j;
  }
  return out;
}

/** Owner of the line: most new chars, else most chars (what the web viewer's ribbon shows). */
function lineOwner(s: [string, string, number][]): string {
  const counts: Record<string, number> = {};
  const fresh: Record<string, number> = {};
  for (const [t, o, isNew] of s) {
    counts[o] = (counts[o] ?? 0) + (t.length || 1);
    if (isNew) fresh[o] = (fresh[o] ?? 0) + (t.length || 1);
  }
  const pick = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0];
  return pick(fresh) ?? pick(counts) ?? "unknown";
}

export function fileDoc(rows: Row[], actors: Record<string, Actor>, opts: { whole?: boolean; focus?: string | null } = {}): Doc {
  const numW = Math.max(3, String(rows.reduce((m, r) => Math.max(m, r.o ?? 0, r.n ?? 0), 0)).length);
  const inks = new Map<string, Ink>();
  const ink = (id: string) => inks.get(id) ?? (inks.set(id, inkOf(id, actors)), inks.get(id)!);
  const all: DocLine[] = rows.map((r) => {
    if (r.k === "del")
      // `d` = [text, removed]: chars actually removed get a stronger wash than ones that survive elsewhere.
      return {
        num: [String(r.o ?? ""), ""],
        sign: "−",
        rib: T.delText,
        body: cleanSpans((r.d ?? []).map(([t, removed]) => ({ t, s: removed ? join(T.delText, T.delWash) : T.delText }))),
        fill: T.delRow,
      };
    const segs = r.s ?? [];
    const owner = lineOwner(segs);
    const k = ink(owner);
    // Highlighting one author: everyone else's new text loses its ink.
    const dim = r.k === "add" && !!opts.focus && !segs.some(([, o, isNew]) => isNew && o === opts.focus);
    const body = cleanSpans(
      segs.map(([t, o, isNew]) =>
        r.k === "add" && isNew ? { t, s: !opts.focus || opts.focus === o ? ink(o).wash : T.muted } : { t, s: dim ? T.muted : undefined }
      )
    );
    return {
      num: [r.k === "ctx" ? String(r.o ?? "") : "", String(r.n ?? "")],
      sign: r.k === "add" ? "+" : " ",
      rib: r.k === "add" ? (dim ? T.faint : k.rib) : T.faint,
      body,
      fill: r.k === "add" && !dim ? k.row : "",
    };
  });
  return { lines: folded(all, rows.map((r) => r.k !== "ctx"), !!opts.whole, numW), numW };
}

/** A single recorded edit: kept text plain, inserted text in the editor's ink, deleted text struck through. */
export function eventDoc(ops: Ops, who: string, actors: Record<string, Actor>): Doc {
  const k = inkOf(who, actors);
  type L = { spans: Span[]; changed: boolean; kept: boolean; old: boolean; removed: boolean };
  const fresh = (): L => ({ spans: [], changed: false, kept: false, old: false, removed: false });
  const ls: L[] = [];
  let cur = fresh();
  for (const [op, text] of ops) {
    const style = op === 1 ? k.wash : op === -1 ? join(T.delText, T.delWash, "9") : undefined;
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (part) cur.spans.push({ t: part, s: style });
      if (part || !last) {
        if (op !== 0) cur.changed = true;
        if (op !== -1) cur.kept = true;
        if (op === 0) cur.old = true;
        if (op === -1) cur.removed = true;
      }
      if (!last) {
        if (op === -1 && !part) cur.spans.push({ t: "↵", s: join(T.delText, T.delWash) });
        ls.push(cur);
        cur = fresh();
      }
    });
  }
  if (cur.spans.length) ls.push(cur);
  let n = 0;
  const numbers = ls.map((l) => (l.kept ? String(++n) : ""));
  const numW = Math.max(3, String(n).length);
  const all: DocLine[] = ls.map((l, i) => {
    const gone = !l.kept;
    return {
      num: ["", numbers[i]],
      sign: gone ? "−" : !l.changed ? " " : l.old || l.removed ? "~" : "+",
      rib: gone ? T.delText : l.changed ? k.rib : T.faint,
      body: cleanSpans(l.spans),
      fill: gone ? T.delRow : l.changed ? k.row : "",
    };
  });
  return { lines: folded(all, ls.map((l) => l.changed), false, numW), numW };
}

type VLine = { gutter: Span[]; body: Span[]; fill: string; src: number };

function layoutDoc(doc: Doc, w: number, showOld: boolean): { lines: VLine[]; hunks: number[] } {
  const gw = (showOld ? doc.numW * 2 + 2 : doc.numW + 1) + 2;
  const bw = Math.max(8, w - gw);
  const lines: VLine[] = [];
  const hunks: number[] = [];
  doc.lines.forEach((l, src) => {
    if (l.hunk) hunks.push(lines.length);
    const nums = (showOld ? [l.num[0].padStart(doc.numW), l.num[1].padStart(doc.numW)].join(" ") : l.num[1].padStart(doc.numW)) + " ";
    if (l.fold !== undefined) {
      const dashes = "─".repeat(Math.max(0, gw - 2));
      lines.push({ gutter: [{ t: dashes + "  ", s: T.rule }], body: l.body, fill: "", src });
      return;
    }
    const parts = wrap(l.body, bw);
    parts.forEach((body, i) =>
      lines.push({
        gutter: [
          { t: i === 0 ? nums : " ".repeat(nums.length), s: T.muted },
          { t: "▌", s: l.rib },
          { t: i === 0 ? l.sign : " ", s: l.sign === "−" ? T.delText : T.muted },
        ],
        body,
        fill: l.fill,
        src,
      })
    );
  });
  return { lines, hunks };
}

/* ───────────────────────── app ───────────────────────── */

type Tab = "changes" | "timeline";
type Focus = "list" | "diff";

function ago(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

const KEYS = /\x1b\[<(\d+);(\d+);(\d+)([mM])|\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[^[O]|\x1b|[\s\S]/gu;

const NAMED: Record<string, string> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[5~": "pgup",
  "\x1b[6~": "pgdn",
  "\x1b[H": "home",
  "\x1b[1~": "home",
  "\x1bOH": "home",
  "\x1b[F": "end",
  "\x1b[4~": "end",
  "\x1bOF": "end",
  "\x1b[Z": "shift-tab",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x1b": "esc",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x15": "ctrl-u",
  "\x06": "ctrl-f",
  "\x02": "ctrl-b",
  "\x0c": "ctrl-l",
};

export type TuiOptions = { base?: string; identity: string; ttl: number; follow?: boolean };

export async function tui(store: Store, opts: TuiOptions): Promise<void> {
  const out = process.stdout;
  const inp = process.stdin;
  if (!out.isTTY || !inp.isTTY) throw new Error("prov tui needs an interactive terminal — use prov ui for the browser viewer");
  T = makeTheme(detectDark());

  const data = new Changes(store);
  const human = store.human(opts.identity);
  const caught = data.catchUp(human, opts.ttl);

  const st = {
    tab: "changes" as Tab,
    focus: "list" as Focus,
    base: opts.base ?? "HEAD",
    sha: null as string | null,
    files: [] as FileChange[],
    events: [] as EditEvent[],
    actors: {} as Record<string, Actor>,
    sel: { changes: "", timeline: "" } as Record<Tab, string>,
    top: { changes: 0, timeline: 0 } as Record<Tab, number>,
    doc: null as Doc | null,
    docKey: "",
    head: { title: "", sub: [] as Span[], legend: [] as Span[] },
    diffTop: 0,
    whole: false,
    authorFocus: null as string | null,
    authors: [] as string[],
    follow: !!opts.follow,
    prompt: null as { value: string; error?: string } | null,
    help: false,
    status: { msg: caught ? `recorded ${caught} file(s) changed while prov wasn't watching` : "", at: Date.now() },
    lastId: 0,
    headSha: "",
    pulse: 0,
    fresh: new Map<string, number>(),
    error: "",
  };

  /* ── data ── */

  const headSha = () => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${st.base}^{commit}`], { cwd: store.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };

  const setStatus = (msg: string) => {
    st.status = { msg, at: Date.now() };
  };

  function reload(): void {
    const sha = data.resolveBase(st.base);
    if (sha === undefined) {
      st.error = `"${st.base}" is not a commit in this repo`;
      st.files = [];
    } else {
      st.error = "";
      st.sha = sha;
      const prev = new Map(st.files.map((f) => [f.path, f]));
      st.files = data.files(sha);
      const now = Date.now();
      if (prev.size || st.lastId)
        for (const f of st.files) {
          const p = prev.get(f.path);
          if (!p || p.addLines !== f.addLines || p.delLines !== f.delLines) st.fresh.set(`f:${f.path}`, now);
        }
    }
    st.actors = data.actors();
    st.events = data.events(500);
    st.lastId = data.lastId();
    st.headSha = headSha();
    if (!st.sel.changes || !st.files.some((f) => f.path === st.sel.changes)) {
      const i = Math.min(selIndex("changes", true), st.files.length - 1);
      st.sel.changes = st.files[Math.max(0, i)]?.path ?? "";
    }
    if (!st.sel.timeline || !st.events.some((e) => String(e.id) === st.sel.timeline)) st.sel.timeline = String(st.events[0]?.id ?? "");
    loadDoc(true);
  }

  let lastSelIdx: Record<Tab, number> = { changes: 0, timeline: 0 };
  function selIndex(tab: Tab, fallback = false): number {
    const i = tab === "changes" ? st.files.findIndex((f) => f.path === st.sel.changes) : st.events.findIndex((e) => String(e.id) === st.sel.timeline);
    if (i >= 0) lastSelIdx[tab] = i;
    return i >= 0 ? i : fallback ? lastSelIdx[tab] : -1;
  }

  function loadDoc(keepScroll = false): void {
    const key = `${st.tab}:${st.sel[st.tab]}`;
    if (key !== st.docKey) {
      st.authorFocus = null;
      keepScroll = false;
    }
    st.docKey = key;
    if (!keepScroll) st.diffTop = 0;
    layoutCache = null;
    if (st.tab === "changes") {
      const f = st.files.find((x) => x.path === st.sel.changes);
      if (!f) {
        st.doc = null;
        return;
      }
      const d = data.diff(st.sha, f.path);
      st.authors = Object.entries(d.added)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
      st.doc = fileDoc(d.rows, st.actors, { whole: st.whole, focus: st.authorFocus });
      const total = Object.values(d.added).reduce((s, n) => s + n, 0) || 1;
      st.head = {
        title: f.path,
        sub: [
          { t: `+${d.addLines}`, s: T.addText },
          { t: " " },
          { t: `−${d.delLines}`, s: T.delText },
          { t: ` since ${st.base}`, s: T.muted },
          { t: f.status === "added" ? " · new file" : f.status === "deleted" ? " · deleted" : "", s: T.muted },
          { t: d.tracked ? "" : " · not recorded by prov yet", s: T.muted },
          { t: st.whole ? " · whole file" : "", s: T.accent },
        ],
        legend: st.authors.flatMap((id) => {
          const k = inkOf(id, st.actors);
          const on = st.authorFocus === id;
          const off = st.authorFocus && !on;
          return [
            { t: "■ ", s: off ? T.faint : k.rib },
            { t: k.label, s: on ? "1;4" : off ? T.faint : undefined },
            { t: ` ${Math.round(((d.added[id] ?? 0) / total) * 100)}%   `, s: T.muted },
          ];
        }),
      };
    } else {
      const e = data.event(Number(st.sel.timeline));
      if (!e) {
        st.doc = null;
        return;
      }
      const who = String(e.env_id);
      const k = inkOf(who, st.actors);
      st.authors = [];
      st.doc = eventDoc(e.ops, who, st.actors);
      st.head = {
        title: e.path,
        sub: [
          { t: `edit #${e.id} · ${new Date(e.ts * 1000).toLocaleString()} · `, s: T.muted },
          { t: `+${e.ins}`, s: T.addText },
          { t: " " },
          { t: `−${e.del}`, s: T.delText },
          { t: " chars", s: T.muted },
        ],
        legend: [{ t: "■ ", s: k.rib }, { t: k.label }, { t: k.human ? "  human" : k.known ? "  agent" : "", s: T.muted }],
      };
    }
  }

  /* ── layout ── */

  let layoutCache: { w: number; key: string; v: ReturnType<typeof layoutDoc> } | null = null;
  const dims = () => {
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const split = cols >= 90;
    const lw = split ? Math.max(30, Math.min(48, Math.round(cols * 0.32))) : cols;
    return { cols, rows, split, lw, rx: split ? lw + 1 : 0, rw: split ? cols - lw - 1 : cols, bodyY: 4, bodyH: Math.max(1, rows - 5) };
  };
  const showList = () => dims().split || st.focus === "list";
  const showDiff = () => dims().split || st.focus === "diff";

  function view() {
    const d = dims();
    if (!st.doc) return { lines: [] as VLine[], hunks: [] as number[] };
    const showOld = st.tab === "changes" && d.rw >= 70;
    const key = `${st.docKey}:${showOld}`;
    if (!layoutCache || layoutCache.w !== d.rw || layoutCache.key !== key || layoutCache.v.lines.length === 0)
      layoutCache = { w: d.rw, key, v: layoutDoc(st.doc, d.rw, showOld) };
    return layoutCache.v;
  }

  const clampDiff = () => {
    const max = Math.max(0, view().lines.length - dims().bodyH);
    st.diffTop = Math.max(0, Math.min(max, st.diffTop));
  };
  const listLen = (tab: Tab) => (tab === "changes" ? st.files.length : st.events.length);
  const itemsPerPage = () => Math.max(1, Math.floor(dims().bodyH / 2));
  const keepSelVisible = () => {
    const i = Math.max(0, selIndex(st.tab));
    const per = itemsPerPage();
    if (i < st.top[st.tab]) st.top[st.tab] = i;
    if (i >= st.top[st.tab] + per) st.top[st.tab] = i - per + 1;
    st.top[st.tab] = Math.max(0, Math.min(st.top[st.tab], Math.max(0, listLen(st.tab) - per)));
  };

  function select(i: number): void {
    const n = listLen(st.tab);
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    st.sel[st.tab] = st.tab === "changes" ? st.files[i].path : String(st.events[i].id);
    keepSelVisible();
    loadDoc();
  }

  /* ── render ── */

  let prevFrame: string[] = [];

  function render(): void {
    const d = dims();
    const L: string[] = new Array(d.rows).fill("");
    const now = Date.now();

    // top bar
    const root = store.root.startsWith(homedir()) ? "~" + store.root.slice(homedir().length) : store.root;
    const live = now - st.pulse < 1500;
    const baseSpans: Span[] = st.prompt
      ? [{ t: " base ", s: T.muted }, { t: clean(st.prompt.value), s: "4" }, { t: "█", s: T.accent }, { t: st.prompt.error ? `  ${st.prompt.error}` : "  enter to apply · esc to cancel", s: st.prompt.error ? T.delText : T.muted }]
      : [{ t: " base ", s: T.muted }, { t: clean(st.base), s: "1" }, { t: st.headSha ? ` ${st.headSha.slice(0, 7)}` : st.sha === null ? " (no commits)" : "", s: T.muted }];
    const right: Span[] = [
      ...(st.follow ? [{ t: " follow ", s: join("7", T.accent) }, { t: "  " }] : []),
      { t: "● ", s: live ? join("1", T.live) : T.live },
      { t: "live", s: T.muted },
      { t: "   ? help ", s: T.muted },
    ];
    const rw = right.reduce((n, s) => n + width(s.t), 0);
    L[0] = fit([{ t: " proveGIT ", s: join("1", T.accent) }, { t: tailFit(clean(root), Math.max(8, d.cols - rw - 50)), s: T.muted }, { t: "  " }, ...baseSpans], d.cols - rw) + fit(right, rw);

    if (showList()) renderList(L, d);
    if (d.split) for (let y = 1; y < d.rows - 1; y++) L[y] += `\x1b[0;${T.rule}m${y === 3 ? "┼" : "│"}\x1b[0m`;
    if (showDiff()) renderDiff(L, d);

    // footer
    const fresh = st.status.msg && now - st.status.at < 6000;
    const hints =
      st.focus === "list"
        ? "↑↓ select  ⏎ open  tab view  f follow  b base  ? help  q quit"
        : "↑↓ scroll  n/N next/prev change  z whole file  a author  esc back  q quit";
    L[d.rows - 1] = fit(fresh ? [{ t: " " + clean(st.status.msg), s: T.accent }] : [{ t: " " + hints, s: T.muted }], d.cols);

    if (st.help) overlayHelp(L, d);

    // Compose: split panes are written left then right on the same row.
    let buf = "\x1b[?2026h";
    for (let y = 0; y < d.rows; y++) {
      if (L[y] !== prevFrame[y]) buf += `\x1b[${y + 1};1H${L[y]}`;
    }
    buf += "\x1b[?2026l";
    prevFrame = L;
    out.write(buf);
  }

  function renderList(L: string[], d: ReturnType<typeof dims>): void {
    const w = d.lw;
    const tabs: Span[] = [
      { t: " " },
      ...(["changes", "timeline"] as Tab[]).flatMap((t) => {
        const on = st.tab === t;
        const n = listLen(t);
        return [
          { t: t === "changes" ? "Changes" : "Timeline", s: on ? join("1", "4", st.focus === "list" ? T.accent : undefined) : T.muted },
          { t: n ? ` ${n}` : "", s: T.muted },
          { t: "   " },
        ];
      }),
    ];
    L[1] += fit(tabs, w);
    let summary: Span[];
    if (st.tab === "changes") {
      const a = st.files.reduce((s, f) => s + f.addLines, 0);
      const r = st.files.reduce((s, f) => s + f.delLines, 0);
      summary = st.files.length
        ? [{ t: ` ${st.files.length} file${st.files.length === 1 ? "" : "s"}  `, s: T.muted }, { t: `+${a}`, s: T.addText }, { t: " " }, { t: `−${r}`, s: T.delText }]
        : [];
    } else summary = [{ t: st.events.length ? " newest first" : "", s: T.muted }];
    L[2] += fit(summary, w);
    L[3] += fit([{ t: "─".repeat(w), s: T.rule }], w);

    const per = itemsPerPage();
    const top = st.top[st.tab];
    const selI = selIndex(st.tab);
    const empty =
      st.error ||
      (st.tab === "changes" ? `No changes since ${st.base}.\nEdits by you or an agent show up here live.` : "No edits recorded yet.\nMake a change, or ask an agent to.");
    const lines: string[] = [];
    if (!listLen(st.tab)) {
      for (const ln of ("\n" + empty).split("\n")) lines.push(fit([{ t: "  " + ln, s: st.error ? T.delText : T.muted }], w));
    } else {
      for (let i = top; i < Math.min(listLen(st.tab), top + per); i++) {
        const on = i === selI;
        const fill = on ? T.sel : "";
        const mark: Span = { t: on ? "▍" : " ", s: on ? T.accent : undefined };
        if (st.tab === "changes") {
          const f = st.files[i];
          const nums = `+${f.addLines} −${f.delLines}`;
          const isFresh = Date.now() - (st.fresh.get(`f:${f.path}`) ?? 0) < 3000;
          const pathW = w - width(nums) - 4;
          lines.push(
            fit(
              [
                mark,
                { t: isFresh ? "●" : " ", s: T.live },
                { t: tailFit(clean(f.path), pathW).padEnd(pathW + 1), s: f.status === "deleted" ? join("9", T.muted) : on ? "1" : undefined },
                { t: `+${f.addLines}`, s: T.addText },
                { t: " " },
                { t: `−${f.delLines}`, s: T.delText },
              ],
              w,
              fill
            )
          );
          lines.push(fit([mark, { t: "  " }, ...inkBar(f.added, 10), { t: " " }, { t: whoLine(f), s: T.muted }], w, fill));
        } else {
          const e = st.events[i];
          const k = inkOf(String(e.env_id), st.actors);
          const nums = `+${e.ins} −${e.del}`;
          const isFresh = Date.now() - (st.fresh.get(`e:${e.id}`) ?? 0) < 3000;
          const pathW = w - width(nums) - 4;
          lines.push(
            fit(
              [
                mark,
                { t: isFresh ? "●" : " ", s: T.live },
                { t: tailFit(clean(e.path ?? ""), pathW).padEnd(pathW + 1), s: on ? "1" : undefined },
                { t: `+${e.ins}`, s: T.addText },
                { t: " " },
                { t: `−${e.del}`, s: T.delText },
              ],
              w,
              fill
            )
          );
          lines.push(fit([mark, { t: "  " }, { t: "■ ", s: k.rib }, { t: clean(k.label) }, { t: ` · ${ago(e.ts)}`, s: T.muted }], w, fill));
        }
      }
    }
    for (let y = 0; y < d.bodyH; y++) L[d.bodyY + y] += lines[y] ?? " ".repeat(w);
  }

  function inkBar(added: Record<string, number>, w: number): Span[] {
    const e = Object.entries(added).sort((a, b) => b[1] - a[1]);
    const total = e.reduce((s, [, n]) => s + n, 0);
    if (!total) return [{ t: "─".repeat(w), s: T.faint }];
    const out: Span[] = [];
    let used = 0;
    e.forEach(([id, n], i) => {
      const cells = i === e.length - 1 ? w - used : Math.max(1, Math.round((n / total) * w));
      const c = Math.min(cells, w - used);
      if (c > 0) out.push({ t: "━".repeat(c), s: inkOf(id, st.actors).rib });
      used += c;
    });
    return out;
  }

  function whoLine(f: FileChange): string {
    const e = Object.entries(f.added).sort((a, b) => b[1] - a[1]);
    const pre = f.status === "added" ? "new · " : f.status === "deleted" ? "deleted · " : "";
    if (!e.length) return pre + "deletions only";
    return pre + clean(inkOf(e[0][0], st.actors).label) + (e.length > 1 ? ` +${e.length - 1}` : "");
  }

  function renderDiff(L: string[], d: ReturnType<typeof dims>): void {
    const w = d.rw;
    const focused = st.focus === "diff";
    if (!st.doc) {
      const msg = st.tab === "changes" ? (st.files.length ? "Select a file" : "Nothing changed yet — waiting for edits…") : "Select an edit";
      const mid = Math.floor(d.rows / 2);
      for (let y = 1; y < d.rows - 1; y++)
        L[y] += y === mid ? fit([{ t: " ".repeat(Math.max(0, Math.floor((w - width(msg)) / 2))) + msg, s: T.muted }], w) : " ".repeat(w);
      return;
    }
    L[1] += fit([{ t: " " }, { t: clean(st.head.title), s: join("1", focused ? T.accent : undefined) }, { t: "  " }, ...st.head.sub], w);
    L[2] += fit([{ t: " " }, ...st.head.legend.map((s) => ({ ...s, t: clean(s.t) }))], w);
    const v = view();
    clampDiff();
    const pos = v.lines.length > d.bodyH ? ` ${Math.round(((st.diffTop + d.bodyH) / v.lines.length) * 100)}% ` : "";
    L[3] += fit([{ t: "─".repeat(Math.max(0, w - pos.length - 1)), s: T.rule }, { t: pos, s: T.muted }, { t: "─", s: T.rule }], w);
    for (let y = 0; y < d.bodyH; y++) {
      const vl = v.lines[st.diffTop + y];
      if (!vl) {
        L[d.bodyY + y] += y === 0 ? fit([{ t: "  This file is empty.", s: T.muted }], w) : " ".repeat(w);
        continue;
      }
      const gw = vl.gutter.reduce((n, s) => n + width(s.t), 0);
      L[d.bodyY + y] += fit(vl.gutter, gw, vl.fill) + fit(vl.body, w - gw, vl.fill);
    }
  }

  function overlayHelp(L: string[], d: ReturnType<typeof dims>): void {
    const rows: [string, string][] = [
      ["↑ ↓  j k", "move selection / scroll diff"],
      ["⏎  →  l", "open the diff pane"],
      ["esc  ←  h", "back to the list"],
      ["tab  1 2", "Changes ↔ Timeline"],
      ["J K", "scroll diff from the list"],
      ["space  pgdn / pgup", "page down / up"],
      ["g  G", "top / bottom"],
      ["n  N", "next / previous change"],
      ["z", "whole file ↔ changes only"],
      ["a  A", "highlight one author / clear"],
      ["f", "follow: jump to each new edit"],
      ["b", "compare against another commit"],
      ["r", "refresh"],
      ["q", "quit"],
    ];
    const bw = Math.min(d.cols - 4, 56);
    const bh = rows.length + 4;
    const x = Math.max(0, Math.floor((d.cols - bw) / 2));
    const y0 = Math.max(1, Math.floor((d.rows - bh) / 2));
    const box: string[] = [];
    box.push(fit([{ t: "╭" + "─".repeat(bw - 2) + "╮", s: T.rule }], bw));
    box.push(fit([{ t: "│", s: T.rule }, { t: " Keys".padEnd(bw - 2), s: "1" }, { t: "│", s: T.rule }], bw));
    for (const [k, v] of rows)
      box.push(fit([{ t: "│ ", s: T.rule }, { t: k.padEnd(20), s: T.accent }, { t: v.padEnd(bw - 24) }, { t: " │", s: T.rule }], bw));
    box.push(fit([{ t: "│", s: T.rule }, { t: " lines are coloured by who wrote them".padEnd(bw - 2), s: T.muted }, { t: "│", s: T.rule }], bw));
    box.push(fit([{ t: "╰" + "─".repeat(bw - 2) + "╯", s: T.rule }], bw));
    box.forEach((b, i) => {
      const y = y0 + i;
      // Overlay rows are drawn whole-width so stale cells never peek through.
      if (y < d.rows - 1) L[y] = fit([], x) + b + fit([], d.cols - x - bw);
    });
  }

  /* ── input ── */

  const page = () => Math.max(1, dims().bodyH - 2);

  function scrollDiff(n: number): void {
    st.diffTop += n;
    clampDiff();
  }

  function jumpHunk(dir: 1 | -1): void {
    const { hunks } = view();
    if (!hunks.length) return setStatus(st.tab === "changes" ? "no changes in this file" : "");
    const target = dir === 1 ? hunks.find((h) => h > st.diffTop + 1) : [...hunks].reverse().find((h) => h < st.diffTop - 1);
    if (target === undefined) return setStatus(dir === 1 ? "last change" : "first change");
    st.diffTop = Math.max(0, target - 2);
    clampDiff();
  }

  function setTab(t: Tab): void {
    if (st.tab === t) return;
    st.tab = t;
    keepSelVisible();
    loadDoc();
  }

  function quit(): void {
    cleanup();
    resolveDone();
  }

  function key(k: string): void {
    if (st.prompt) {
      if (k === "esc") st.prompt = null;
      else if (k === "enter") {
        const ref = st.prompt.value.trim() || "HEAD";
        if (data.resolveBase(ref) === undefined) st.prompt.error = `"${ref}" is not a commit`;
        else {
          st.base = ref;
          st.prompt = null;
          st.sel.changes = "";
          reload();
          setStatus(`comparing against ${ref}`);
        }
      } else if (k === "backspace") {
        st.prompt.value = st.prompt.value.slice(0, -1);
        st.prompt.error = undefined;
      } else if (k === "ctrl-u") st.prompt.value = "";
      else if (k === "ctrl-c") quit();
      else if (k.length === 1 && k >= " ") {
        st.prompt.value += k;
        st.prompt.error = undefined;
      }
      return;
    }
    if (st.help) {
      st.help = false;
      if (k !== "q" && k !== "ctrl-c") return;
    }
    const inList = st.focus === "list";
    const i = selIndex(st.tab);
    switch (k) {
      case "q":
      case "ctrl-c":
        return quit();
      case "?":
        st.help = true;
        return;
      case "tab":
      case "shift-tab":
        return setTab(st.tab === "changes" ? "timeline" : "changes");
      case "1":
        return setTab("changes");
      case "2":
        return setTab("timeline");
      case "enter":
      case "right":
      case "l":
        if (st.doc) st.focus = "diff";
        return;
      case "esc":
      case "left":
      case "h":
        st.focus = "list";
        return;
      case "down":
      case "j":
        return inList ? select(i + 1) : scrollDiff(1);
      case "up":
      case "k":
        return inList ? select(i - 1) : scrollDiff(-1);
      case "J":
        return scrollDiff(1);
      case "K":
        return scrollDiff(-1);
      case "pgdn":
      case " ":
      case "ctrl-f":
        return inList ? select(i + itemsPerPage()) : scrollDiff(page());
      case "pgup":
      case "ctrl-b":
        return inList ? select(i - itemsPerPage()) : scrollDiff(-page());
      case "ctrl-d":
        return scrollDiff(Math.ceil(page() / 2));
      case "ctrl-u":
        return scrollDiff(-Math.ceil(page() / 2));
      case "g":
      case "home":
        return inList ? select(0) : void (st.diffTop = 0);
      case "G":
      case "end":
        return inList ? select(listLen(st.tab) - 1) : scrollDiff(1e9);
      case "n":
      case "]":
        return jumpHunk(1);
      case "N":
      case "[":
        return jumpHunk(-1);
      case "z":
        if (st.tab !== "changes") return;
        st.whole = !st.whole;
        return loadDoc(true);
      case "a": {
        if (!st.authors.length) return;
        const at = st.authorFocus ? st.authors.indexOf(st.authorFocus) : -1;
        st.authorFocus = at + 1 < st.authors.length ? st.authors[at + 1] : null;
        loadDoc(true);
        return setStatus(st.authorFocus ? `highlighting ${inkOf(st.authorFocus, st.actors).label}` : "all authors");
      }
      case "A":
        st.authorFocus = null;
        return loadDoc(true);
      case "f":
        st.follow = !st.follow;
        return setStatus(st.follow ? "follow on — jumping to each new edit" : "follow off");
      case "b":
        st.prompt = { value: st.base === "HEAD" ? "" : st.base };
        return;
      case "r":
      case "ctrl-l":
        prevFrame = [];
        reload();
        return setStatus("refreshed");
    }
  }

  function mouse(b: number, x: number, y: number, press: boolean): void {
    const d = dims();
    const inDiff = d.split ? x > d.lw : st.focus === "diff";
    if (b === 64 || b === 65) {
      const n = b === 64 ? -3 : 3;
      if (inDiff) scrollDiff(n);
      else {
        st.top[st.tab] = Math.max(0, Math.min(Math.max(0, listLen(st.tab) - itemsPerPage()), st.top[st.tab] + Math.sign(n)));
      }
      return;
    }
    if (!press || (b & 3) !== 0 || st.help || st.prompt) return;
    if (inDiff) {
      st.focus = "diff";
      if (y === 3 && st.authors.length) key("a");
      return;
    }
    st.focus = "list";
    if (y === 2) {
      // tabs row: "Changes" lives in the first half
      return setTab(x <= 12 + String(st.files.length).length ? "changes" : "timeline");
    }
    if (y - 1 >= d.bodyY) select(st.top[st.tab] + Math.floor((y - 1 - d.bodyY) / 2));
  }

  function onData(chunk: string): void {
    for (const m of chunk.matchAll(KEYS)) {
      if (m[1] !== undefined) mouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "M");
      else key(NAMED[m[0]] ?? m[0]);
    }
    render();
  }

  /* ── live ── */

  let ticks = 0;
  function tick(): void {
    const id = data.lastId();
    // Commits/checkouts move the base without a prov event; check git every 2s.
    const head = ++ticks % 4 === 0 ? headSha() : st.headSha;
    if (id !== st.lastId || head !== st.headSha) {
      const before = st.lastId;
      st.pulse = Date.now();
      reload();
      if (id > before) {
        const fresh = st.events.filter((e) => e.id > before);
        for (const e of fresh) st.fresh.set(`e:${e.id}`, Date.now());
        const e = fresh[0];
        if (e) {
          setStatus(`${e.path} ← ${inkOf(String(e.env_id), st.actors).label}  +${e.ins} −${e.del}`);
          if (st.follow) {
            if (st.files.some((f) => f.path === e.path)) st.sel.changes = e.path;
            st.sel.timeline = String(e.id);
            keepSelVisible();
            loadDoc();
            const { hunks } = view();
            if (hunks.length) st.diffTop = Math.max(0, hunks[0] - 2);
          }
        }
      }
    }
    render();
  }

  /* ── terminal lifecycle ── */

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    inp.off("data", onData);
    out.off("resize", onResize);
    try {
      inp.setRawMode(false);
    } catch {}
    inp.pause();
    out.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[0m\x1b[?1049l");
  };
  const onResize = () => {
    prevFrame = [];
    layoutCache = null;
    out.write("\x1b[2J");
    keepSelVisible();
    render();
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, () => (cleanup(), process.exit(0)));
  process.once("uncaughtException", (e) => {
    cleanup();
    console.error(e);
    process.exit(1);
  });

  out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J");
  inp.setRawMode(true);
  inp.setEncoding("utf8");
  inp.on("data", onData);
  inp.resume();
  out.on("resize", onResize);

  reload();
  render();
  const timer = setInterval(tick, 500);
  // Record live edits (yours, or agents' between hooks) in-process; its log goes to the status line.
  watch(store.root, store, opts.identity, opts.ttl, (s) => {
    if (!s.startsWith("watching ")) setStatus(s);
  }).catch((e) => setStatus(`watch error: ${e?.message ?? e}`));

  await done;
}
