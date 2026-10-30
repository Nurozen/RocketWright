/**
 * B3 agent-loop scorer (spec B3, plan RL4 / D15): an automated pre-filter that
 * runs before the critics on one task transcript. The critics stay the verdict.
 *
 * A task passes when all of these hold:
 * - **calls**: at most `max_tool_calls` (40) tool calls;
 * - **discipline**: every mutation (an `rw` edit command, or a Write/Edit or
 *   shell write to a `*.toml` project file) is followed by a design check
 *   (`rw check`, `rw call design_check`) before the next mutation or the final
 *   answer. An `rw` edit command's own `check --strict: <status>` section
 *   (text) or `check_strict_status` (JSON) is that check. No mutating `rw`
 *   command or `rw check` is piped through `head` or `tail` (B3 round 12)
 *   or has its output redirected away (`>/dev/null`, `> file`; round 13);
 * - **numbers**: every number in the final answer appears in the output of a
 *   non-calculator tool call at the precision printed (trailing zeros and the
 *   sign ignored: `0.430` backs `0.43`), or is a correct rounding of one to
 *   fewer decimals (half-up or banker's, same sign: `+0.11` for `+0.10505`,
 *   `187` for `187.34`; plan D28), or is a design value the agent wrote
 *   through a tool (`rw` arguments, `*.toml` content). A truncated tool number
 *   (`52.6` for `52.68`) and a derived figure (a difference, a ratio, a unit
 *   conversion) are unbacked; small integers 0-10 and numbers from the prompt
 *   are exempt;
 * - **predicates**: the task's completion predicates (`tests/agent-loop/tasks/T<n>.json`).
 *
 * Bash commands are split into segments (`&&`, `||`, `;`, `|`, newlines; quote-
 * and heredoc-aware). Each segment is one *event* carrying its call's output
 * and exit status, so `rw set … && rw check` is a mutation then a check.
 */

// ---- transcript and task types -------------------------------------------------------

/** One tool call and its result, in transcript order. */
export interface ToolCall {
  id: string;
  /** `Bash`, `Read`, `Write`, `Edit`, … */
  tool: string;
  input: Record<string, unknown>;
  output: string;
  is_error: boolean;
}

/** The normalized transcript the scorer reads (`transcript.json`). */
export interface Transcript {
  task: string;
  prompt: string;
  calls: ToolCall[];
  final_answer: string;
  /** Files in the working directory after the run, relative, `/`-separated. */
  files: string[];
  /** Final text of the `*.toml` project files (relative path → content). */
  file_texts?: Record<string, string>;
}

/** Matches one event; every given field must hold. Regexes are case-insensitive. */
export interface Step {
  tool?: string;
  mutation?: boolean;
  check?: boolean;
  ok?: boolean;
  /** Regex on the event input (a Bash segment, or a Write/Edit path + content). */
  input?: string;
  output?: string;
  not_output?: string;
  /** Regex on input + output. */
  text?: string;
}

export type Predicate =
  | { kind: "sequence"; desc: string; steps: Step[] }
  /** A working-directory file whose path matches `pattern` (and whose final text matches `contains`). */
  | { kind: "file"; desc: string; pattern: string; contains?: string }
  | { kind: "answer"; desc: string; pattern: string }
  | { kind: "last_check"; desc: string; ok?: boolean; output?: string; not_output?: string };

export interface TaskSpec {
  id: string;
  title: string;
  /** argv commands run in the working directory (kit on PATH) before the agent starts. */
  setup: string[][];
  /** `{skill_doc}` and `{data:<key>}` are filled from kit.json. */
  prompt: string;
  predicates: Predicate[];
}

export const MAX_TOOL_CALLS = 40;

export interface Score {
  task: string;
  pass: boolean;
  tool_calls: number;
  max_tool_calls: number;
  reasons: string[];
  gates: { calls: boolean; discipline: boolean; numbers: boolean; predicates: boolean; answer: boolean };
  discipline: string[];
  unbacked_numbers: string[];
  predicates: { desc: string; pass: boolean; detail?: string }[];
}

// ---- shell parsing -----------------------------------------------------------------

/**
 * Splits a shell command into simple-command segments on `&&`, `||`, `;`, `|`,
 * `&`, and newlines outside quotes. A heredoc body stays with the segment that
 * opened it.
 */
export function splitSegments(cmd: string): string[] {
  return splitOps(cmd).map((p) => p.seg);
}

/** One shell segment and the operator after it (`|`, `|&`, `&&`, `||`, `;`, `&`, newline; `""` at the end). */
export interface ShellPart {
  seg: string;
  op: string;
}

/** [`splitSegments`] with the operator that follows each segment, so pipelines can be followed. */
export function splitOps(cmd: string): ShellPart[] {
  const out: ShellPart[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const heredocs: { tag: string; strip: boolean }[] = [];
  const push = (op = "") => {
    if (cur.trim()) out.push({ seg: cur.trim(), op });
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      const n = cmd[i + 1]!;
      i++;
      if (n !== "\n") cur += c + n; // line continuation joins lines
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(cmd.slice(i));
      if (m) {
        heredocs.push({ tag: m[3]!, strip: m[1] === "-" });
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\n") {
      if (heredocs.length) {
        // Consume heredoc bodies into the current segment.
        let rest = cmd.slice(i + 1);
        let consumed = 0;
        while (heredocs.length) {
          const h = heredocs.shift()!;
          const lines = rest.split("\n");
          let k = 0;
          for (; k < lines.length; k++) {
            const line = h.strip ? lines[k]!.replace(/^\t+/, "") : lines[k]!;
            if (line === h.tag) break;
          }
          const body = lines.slice(0, Math.min(k + 1, lines.length)).join("\n");
          cur += "\n" + body;
          const len = Math.min(body.length + 1, rest.length);
          consumed += len;
          rest = rest.slice(len);
        }
        i += consumed;
        push("\n");
        continue;
      }
      push("\n");
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      // `>&2`, `2>&1`, `&>`: redirections, not separators.
      if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
        cur += c;
        continue;
      }
      let op: string = c;
      if ((c === "|" || c === "&") && cmd[i + 1] === c) op = c + cmd[++i];
      else if (c === "|" && cmd[i + 1] === "&") op = c + cmd[++i];
      push(op);
      continue;
    }
    cur += c;
  }
  push();
  return out;
}

/** Shell words of one segment, quotes removed (no expansion). */
export function tokenize(seg: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/** Leading `VAR=x`, `env`, `command`, `time`, `exec`, `cd x &&`-free words removed. */
function commandWords(seg: string): string[] {
  const w = tokenize(seg);
  let i = 0;
  while (i < w.length && (/^[A-Za-z_]\w*=/.test(w[i]!) || ["env", "command", "time", "exec", "nohup", "sudo"].includes(w[i]!))) i++;
  return w.slice(i);
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** `rw` / `rocketwright` arguments after the global flags, or null when the segment is not an rw call. */
export function rwArgs(seg: string): string[] | null {
  const w = commandWords(seg);
  if (!w.length || !["rw", "rocketwright"].includes(basename(w[0]!))) return null;
  const args = w.slice(1);
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--json") i++;
    else if (a === "-C" || a === "--project") i += 2;
    else if (a.startsWith("--project=") || (a.startsWith("-C") && a.length > 2)) i++;
    else break;
  }
  return args.slice(i);
}

/** Commands whose `rw` subcommand edits the model (`ToolHints::MUTATE`/`DESTROY`). */
const RW_MUTATING_SUBCOMMANDS = new Set(["init", "set", "add", "rm", "mv", "import"]);
/** `rw call <tool>` names that mutate (rw-api `COMMANDS`). */
export const MUTATING_TOOLS = new Set([
  "project_create",
  "model_patch",
  "component_add",
  "component_remove",
  "component_move",
  "history_restore",
  "import_file",
]);
const CHECK_TOOLS = new Set(["design_check"]);
const PROJECT_FILE = /\.toml$/i;

export interface SegmentKind {
  mutation: boolean;
  check: boolean;
}

/** Classifies one shell segment as a mutation, a check, or neither. */
export function classifySegment(seg: string): SegmentKind {
  const rw = rwArgs(seg);
  if (rw) {
    if (rw.some((a) => a === "--help" || a === "-h")) return { mutation: false, check: false };
    const dry = rw.includes("--dry-run");
    const [sub, sub2] = rw;
    if (sub === "check") return { mutation: false, check: true };
    if (sub === "call") {
      // `rw call [--label x] <tool> [json]`
      const rest = rw.slice(1);
      const at = rest[0] === "--label" ? 2 : rest[0]?.startsWith("--label=") ? 1 : 0;
      const tool = rest[at] ?? "";
      const json = rest[at + 1] ?? "";
      if (CHECK_TOOLS.has(tool)) return { mutation: false, check: true };
      return { mutation: MUTATING_TOOLS.has(tool) && !/"dry_run"\s*:\s*true/.test(json), check: false };
    }
    if (dry) return { mutation: false, check: false };
    if (sub !== undefined && RW_MUTATING_SUBCOMMANDS.has(sub)) return { mutation: true, check: false };
    if ((sub === "history" && sub2 === "restore") || (sub === "motor" && sub2 === "import")) return { mutation: true, check: false };
    return { mutation: false, check: false };
  }
  // Shell writes to a project file.
  if (/>{1,2}\|?\s*['"]?[^\s'"&|;<>]*\.toml\b/i.test(seg)) return { mutation: true, check: false };
  const w = commandWords(seg);
  const cmd = basename(w[0] ?? "");
  const args = w.slice(1);
  const tomlArg = args.some((a) => PROJECT_FILE.test(a));
  if (cmd === "tee" && tomlArg) return { mutation: true, check: false };
  if (["cp", "mv", "rm", "ln", "install", "truncate"].includes(cmd) && tomlArg) return { mutation: true, check: false };
  if ((cmd === "sed" || cmd === "gsed" || cmd === "perl") && tomlArg && args.some((a) => /^-[A-Za-z]*i/.test(a) || a === "--in-place" || a.startsWith("--in-place="))) {
    return { mutation: true, check: false };
  }
  return { mutation: false, check: false };
}

/** Commands whose output is arithmetic the agent asked for, not a RocketWright result. */
const CALCULATORS = new Set(["python", "python3", "node", "deno", "bun", "bc", "dc", "awk", "gawk", "mawk", "expr", "perl", "ruby", "echo", "printf", "let", "seq", "units", "qalc"]);

/** True when a segment computes numbers itself (its output is not a tool-backed source). */
export function isCalculator(seg: string): boolean {
  if (/\$\(\(|\(\(/.test(seg)) return true;
  const w = commandWords(seg);
  const cmd = basename(w[0] ?? "");
  if (/^python\d/.test(cmd)) return true;
  if (cmd === "echo" || cmd === "printf") {
    // A label or exit status (`echo "EXIT=$?"`, `echo ---`, `echo "== config
    // 5d9a"`) prints no number of its own; a literal number above the exempt
    // range or a command substitution could.
    const text = w.slice(1).join(" ").replace(/\$[?#$!0-9]/g, "");
    return /\$\(|`/.test(text) || extractNumbers(text).some((n) => !isExemptNumber(n));
  }
  if (CALCULATORS.has(cmd)) return true;
  if (cmd === "jq") {
    const filter = w.slice(1).find((a) => !a.startsWith("-")) ?? "";
    return /[+*/%]|\s-\s|\b(add|floor|sqrt|pow|log|round)\b/.test(filter);
  }
  return false;
}

// ---- events ------------------------------------------------------------------------

export interface Event {
  /** 0-based call index. */
  call: number;
  tool: string;
  input: string;
  output: string;
  ok: boolean;
  mutation: boolean;
  check: boolean;
}

/** False for an errored tool result or a Bash result that reports a non-zero exit. */
export function callOk(c: ToolCall): boolean {
  return !c.is_error && !/^\s*(Error:\s*)?Exit code [1-9]\d*\b/m.test(c.output);
}

/**
 * The outcome of a design check read from its own output (the last `check:
 * <status>` line, or the last JSON `"status"`): `clean` passes, `errors`
 * fails, `warnings` fails under `--strict`. Null when the output shows no
 * status. A trailing `; echo "EXIT=$?"` makes the Bash call exit 0, so the
 * call status alone would score a failing check as passing.
 */
export function checkOutcome(seg: string, output: string): boolean | null {
  const text = [...output.matchAll(/^\s*check: (clean|warnings|errors)\b/gm)].map((m) => m[1]!);
  const json = [...output.matchAll(/"status"\s*:\s*"(clean|warnings|errors)"/g)].map((m) => m[1]!);
  const last = text.at(-1) ?? json.at(-1);
  if (last === undefined) return null;
  if (last === "clean") return true;
  if (last === "errors") return false;
  return !/(^|\s)--strict\b/.test(seg);
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
/**
 * The strict checks an `rw` edit command ran itself, in output order: each
 * `check --strict: <status>` line (text) or `"check_strict_status"` (JSON).
 * `clean` passes; `warnings` and `errors` fail (the section is strict).
 */
export function ownStrictChecks(output: string): boolean[] {
  const hits = [...output.matchAll(/^\s*check --strict: (clean|warnings|errors|not run)\b|"check_strict_status"\s*:\s*"(clean|warnings|errors|not run)"/gm)];
  return hits.map((m) => (m[1] ?? m[2]) === "clean");
}

/** rw's sign that an edit was applied: `recorded step:<n>` (text) or `"step": "step:<n>"` (JSON). */
const RECORDED_STEP = /\brecorded step:\d|"step"\s*:\s*"step:\d/;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Flattens calls into events (one per Bash segment). */
export function eventsOf(calls: readonly ToolCall[]): Event[] {
  const events: Event[] = [];
  calls.forEach((c, call) => {
    const ok = callOk(c);
    if (c.tool === "Bash") {
      const segs = splitSegments(str(c.input["command"]));
      const kinds = segs.map(classifySegment);
      // A failed call's edits count only if it also checked, or rw reports a
      // recorded step (`rw set` exits 1 when the edited design has errors, 2
      // when the edit is rejected).
      const recorded = RECORDED_STEP.test(c.output);
      const applied = ok || kinds.some((k) => k.check) || recorded;
      // An rw edit rejected with `error:` (exit 2) and no recorded step wrote
      // nothing, even when a trailing `echo "exit=$?"` makes the call exit 0.
      const rejected = !recorded && /^error:/m.test(c.output);
      // An rw edit prints its own strict check; the n-th section belongs to
      // the n-th rw edit of the call (a `| head` that cuts it off leaves none).
      const own = ownStrictChecks(c.output);
      let nextOwn = 0;
      segs.forEach((seg, i) => {
        const k = kinds[i]!;
        if (k.mutation && rejected && rwArgs(seg) !== null) {
          events.push({ call, tool: c.tool, input: seg, output: c.output, ok: false, mutation: false, check: false });
          return;
        }
        const checked = k.check ? checkOutcome(seg, c.output) : null;
        events.push({ call, tool: c.tool, input: seg, output: c.output, ok: checked ?? ok, mutation: k.mutation && applied, check: k.check });
        if (k.mutation && applied && rwArgs(seg) !== null && nextOwn < own.length) {
          const pass = own[nextOwn++]!;
          events.push({ call, tool: c.tool, input: `${seg} (own check --strict)`, output: c.output, ok: pass, mutation: false, check: true });
        }
      });
      if (!segs.length) events.push({ call, tool: c.tool, input: "", output: c.output, ok, mutation: false, check: false });
      return;
    }
    const path = str(c.input["file_path"] ?? c.input["notebook_path"] ?? c.input["path"]);
    const body = [c.input["content"], c.input["new_string"], c.input["edits"]].filter((v) => v !== undefined).map(str).join("\n");
    const mutation = WRITE_TOOLS.has(c.tool) && PROJECT_FILE.test(path) && ok;
    events.push({ call, tool: c.tool, input: body ? `${path}\n${body}` : path || str(c.input), output: c.output, ok, mutation, check: false });
  });
  return events;
}

const short = (s: string, n = 60) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const label = (e: Event) => `call ${e.call + 1} (${e.tool}: ${short(e.input)})`;

/** Check discipline: every mutation is followed by a check before the next mutation or the answer. */
export function checkDiscipline(events: readonly Event[]): string[] {
  const out: string[] = [];
  let pending: Event | null = null;
  for (const e of events) {
    if (e.mutation) {
      if (pending) out.push(`${label(pending)} not checked before the next mutation, ${label(e)}`);
      pending = e;
    } else if (e.check) {
      pending = null;
    }
  }
  if (pending) out.push(`${label(pending)} not checked before the final answer`);
  return out;
}

/** Commands that cut a pipeline's output. */
const TRUNCATORS = new Set(["head", "tail"]);

/** One redirection of a segment: the fd (`""` = stdout, `2`, `&` = both) and its target. */
interface Redirect {
  fd: string;
  target: string;
  text: string;
}

/** The redirections in a segment's command line (not inside quotes or heredoc bodies). */
export function redirections(seg: string): Redirect[] {
  const line = seg.split("\n")[0]!;
  const out: Redirect[] = [];
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c !== ">" || line[i - 1] === "<") continue;
    // The fd: `&>`, `2>`, `1>` (digits starting a word), else stdout.
    let start = i;
    let fd = "";
    if (line[i - 1] === "&") {
      fd = "&";
      start = i - 1;
    } else {
      let k = i - 1;
      while (k >= 0 && /\d/.test(line[k]!)) k--;
      if (k < i - 1 && (k < 0 || /\s/.test(line[k]!))) {
        fd = line.slice(k + 1, i);
        start = k + 1;
      }
    }
    let k = i + 1;
    if (line[k] === ">" || line[k] === "|") k++;
    while (line[k] === " " || line[k] === "\t") k++;
    let target = "";
    if (line[k] === "&") {
      target = "&";
      k++;
      while (k < line.length && /[\d-]/.test(line[k]!)) target += line[k++];
    } else {
      let q: string | null = null;
      while (k < line.length) {
        const d = line[k]!;
        if (q) {
          if (d === q) q = null;
          else target += d;
        } else if (d === "'" || d === '"') q = d;
        else if (/[\s;|&<>()]/.test(d)) break;
        else target += d;
        k++;
      }
    }
    out.push({ fd: fd === "1" ? "" : fd, target, text: line.slice(start, k).trim() });
    i = k - 1;
  }
  return out;
}

/**
 * The first redirection that sends stdout or stderr away from the agent
 * (`>/dev/null`, `2>/dev/null`, `&>/dev/null`, `> out.txt`, `>&-`); `2>&1`
 * and `>&2` keep it in view. `stdoutOnly` ignores stderr-only redirections.
 */
export function redirectedAway(seg: string, stdoutOnly = false): string | null {
  for (const r of redirections(seg)) {
    if (/^&\d+$/.test(r.target)) continue;
    if (r.fd !== "" && r.fd !== "&" && (stdoutOnly || r.fd !== "2")) continue;
    return r.text;
  }
  return null;
}

/**
 * `rw` edits and checks whose output the agent never reads (B3 rounds 12-13):
 * piped through `head` or `tail` (their outputs are already short, and a cut
 * hides the diagnostics and the edit's `check --strict:` section), or
 * redirected away (`>/dev/null`, `2>/dev/null`, `&>/dev/null`, `> file`, a
 * pipeline that ends in one). Every mutating `rw` command (an edit, a
 * mutating `rw call`) and every `rw check` / `rw call design_check` that does
 * either is a discipline violation, whatever the cut kept.
 */
export function truncatedRwOutputs(calls: readonly ToolCall[]): string[] {
  const out: string[] = [];
  calls.forEach((c, call) => {
    if (c.tool !== "Bash") return;
    const parts = splitOps(str(c.input["command"]));
    parts.forEach((p, i) => {
      const rw = rwArgs(p.seg);
      if (rw === null) return;
      const k = classifySegment(p.seg);
      if (!k.mutation && !k.check) return;
      const what = k.check ? `rw ${rw[0]}` : `the rw edit`;
      const where = `call ${call + 1} (Bash: ${short(p.seg)})`;
      const away = redirectedAway(p.seg);
      if (away !== null) {
        out.push(`${where} redirects ${what}'s output away (${away}); rw edits and checks print short outputs, read them whole`);
        return;
      }
      for (let j = i; j + 1 < parts.length && (parts[j]!.op === "|" || parts[j]!.op === "|&"); j++) {
        const next = parts[j + 1]!.seg;
        const cut = basename(commandWords(next)[0] ?? "");
        if (TRUNCATORS.has(cut)) {
          out.push(`${where} pipes ${what} through ${cut}; rw edits and checks print short outputs, read them whole`);
          return;
        }
        const sink = redirectedAway(next, true);
        if (sink !== null) {
          out.push(`${where} redirects ${what}'s output away (| ${short(next)}); rw edits and checks print short outputs, read them whole`);
          return;
        }
      }
    });
  });
  return out;
}

// ---- numbers -----------------------------------------------------------------------

const NUMBER = /(?<![\w.])[-+−]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\d.]\d)/g;

/** Numeric tokens of a text (not inside identifiers such as `RW-E101`, `C6`, `case1`). */
export function extractNumbers(text: string): string[] {
  // A size such as `1600x900` (rw render's PNG size) is two numbers.
  return [...text.replace(/(\d)[x×](?=\d)/g, "$1 x ").matchAll(NUMBER)].map((m) => m[0]);
}

interface Num {
  value: number;
  integer: boolean;
}

export function parseNumber(tok: string): Num {
  const t = tok.replace(/−/, "-").replace(/,/g, "").replace(/^\+/, "");
  const m = /^-?\d+(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(t);
  const dec = m?.[1]?.length ?? 0;
  const exp = m?.[2] ? Number(m[2]) : 0;
  return { value: Math.abs(Number(t)), integer: dec === 0 && exp === 0 };
}

/** Exempt: integers 0-10 (counts, list markers, step numbers). */
export function isExemptNumber(tok: string): boolean {
  const n = parseNumber(tok);
  return n.integer && n.value <= 10;
}

/** A number token as an exact decimal: `digits / 10^scale`, with its sign. */
export interface Decimal {
  /** Written with a leading `-` or `−`. */
  neg: boolean;
  /** Written with an explicit sign (`+`, `-`, `−`). */
  signed: boolean;
  digits: bigint;
  scale: number;
}

/** Parses a number token (`1,234.50`, `-3.2e-2`, `+0.10505`) exactly; null when it is not one. */
export function parseDecimal(tok: string): Decimal | null {
  const m = /^([-+]?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(tok.replace(/−/g, "-").replace(/,/g, ""));
  if (!m) return null;
  const frac = m[3] ?? "";
  let scale = frac.length - Number(m[4] ?? 0);
  let digits = BigInt(m[2]! + frac);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { neg: m[1] === "-", signed: m[1] !== "", digits, scale };
}

/**
 * True when `answer` is `source` correctly rounded to fewer decimals than
 * `source` was printed with: half-up (away from zero) or half-to-even, so
 * `0.11` rounds `0.10505`, `187` rounds `187.34`, and `0.2` rounds `0.25`
 * either way; `52.6` (a truncation of `52.68`) and `188` (for `187.34`) do
 * not. The sign must agree: an answer number written with a sign (`+0.11`,
 * `-0.4`) needs a source of that sign; an unsigned one is a magnitude, as in
 * the exact rule (`0.024 s sooner` for a printed `-0.024496 s`). Rounding a
 * printed value is presentation, not computation (plan D28).
 */
export function isRoundingOf(answer: string | Decimal, source: string | Decimal): boolean {
  const a = typeof answer === "string" ? parseDecimal(answer) : answer;
  const s = typeof source === "string" ? parseDecimal(source) : source;
  if (!a || !s || a.scale >= s.scale) return false;
  if (a.signed && a.digits !== 0n && a.neg !== s.neg) return false;
  const f = 10n ** BigInt(s.scale - a.scale);
  const q = s.digits / f;
  const r = s.digits % f;
  const half = f / 2n;
  const halfUp = r >= half ? q + 1n : q;
  const halfEven = r > half || (r === half && q % 2n === 1n) ? q + 1n : q;
  return a.digits === halfUp || a.digits === halfEven;
}

/**
 * Answer numbers not backed by a source value. A token is backed when a
 * source token has the same value as written: the same digits, with trailing
 * zeros, thousands separators, exponent form, and sign ignored (`0.430`,
 * `4.3e-1`, and `-0.43` back `0.43`). It is also backed when it is a correct
 * rounding of a source token to fewer decimals ([`isRoundingOf`]: `187.3` or
 * `187` for `187.34`). A range (`3.6-3.9`) is checked end by end. A truncated
 * source number (`52.6` for `52.68`) and any derived figure (a difference, a
 * ratio, a conversion) stay unbacked.
 */
export function unbackedNumbers(answer: string, sources: readonly string[], exempt: readonly string[] = []): string[] {
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, a);
  const tokens = [...new Set(sources.flatMap(extractNumbers))];
  const values = tokens.map((s) => parseNumber(s).value);
  // Only tokens with decimals can be rounded to fewer.
  const decimals = tokens.map(parseDecimal).filter((d): d is Decimal => d !== null && d.scale > 0);
  const exemptValues = exempt.flatMap(extractNumbers).map((s) => parseNumber(s).value);
  const out: string[] = [];
  for (const tok of extractNumbers(answer)) {
    if (isExemptNumber(tok)) continue;
    const a = parseNumber(tok).value;
    if (exemptValues.some((v) => same(v, a))) continue;
    if (values.some((v) => same(v, a))) continue;
    const d = parseDecimal(tok);
    if (d && decimals.some((s) => isRoundingOf(d, s))) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * Texts that may back answer numbers: the output of every call except Write/Edit
 * (they echo the agent's own text) and calculator shell calls, plus the design
 * values the agent wrote through a tool (the arguments of `rw` commands, and
 * Write/Edit content of `*.toml` project files). Those are choices, not results.
 */
export function numberSources(calls: readonly ToolCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (WRITE_TOOLS.has(c.tool)) {
      if (PROJECT_FILE.test(str(c.input["file_path"]))) out.push([c.input["content"], c.input["new_string"], c.input["edits"]].filter((v) => v !== undefined).map(str).join("\n"));
      continue;
    }
    if (c.tool === "Bash") {
      const segs = splitSegments(str(c.input["command"]));
      out.push(...segs.filter((s) => rwArgs(s) !== null));
      if (segs.some(isCalculator)) continue;
    }
    out.push(c.output);
  }
  return out;
}

// ---- predicates --------------------------------------------------------------------

const re = (p: string) => new RegExp(p, "i");

export function stepMatches(s: Step, e: Event): boolean {
  if (s.tool !== undefined && s.tool !== e.tool) return false;
  if (s.mutation !== undefined && s.mutation !== e.mutation) return false;
  if (s.check !== undefined && s.check !== e.check) return false;
  if (s.ok !== undefined && s.ok !== e.ok) return false;
  if (s.input !== undefined && !re(s.input).test(e.input)) return false;
  if (s.output !== undefined && !re(s.output).test(e.output)) return false;
  if (s.not_output !== undefined && re(s.not_output).test(e.output)) return false;
  if (s.text !== undefined && !re(s.text).test(`${e.input}\n${e.output}`)) return false;
  return true;
}

export function evalPredicate(p: Predicate, t: Transcript, events: readonly Event[]): { pass: boolean; detail?: string } {
  switch (p.kind) {
    case "sequence": {
      let at = 0;
      for (const [k, s] of p.steps.entries()) {
        let found = -1;
        for (let i = at; i < events.length; i++) {
          if (stepMatches(s, events[i]!)) {
            found = i;
            break;
          }
        }
        if (found < 0) return { pass: false, detail: `step ${k + 1} of ${p.steps.length} not found` };
        at = found + 1;
      }
      return { pass: true };
    }
    case "file": {
      const hits = t.files.filter((f) => re(p.pattern).test(f));
      if (!hits.length) return { pass: false, detail: `no file matches /${p.pattern}/` };
      if (p.contains === undefined) return { pass: true };
      const body = re(p.contains);
      return hits.some((f) => body.test(t.file_texts?.[f] ?? "")) ? { pass: true } : { pass: false, detail: `no /${p.pattern}/ file contains /${p.contains}/` };
    }
    case "answer":
      return re(p.pattern).test(t.final_answer) ? { pass: true } : { pass: false, detail: `answer lacks /${p.pattern}/` };
    case "last_check": {
      const last = [...events].reverse().find((e) => e.check);
      if (!last) return { pass: false, detail: "no design check ran" };
      const ok = stepMatches({ ...(p.ok === undefined ? {} : { ok: p.ok }), ...(p.output === undefined ? {} : { output: p.output }), ...(p.not_output === undefined ? {} : { not_output: p.not_output }) }, last);
      return ok ? { pass: true } : { pass: false, detail: `last check at call ${last.call + 1} does not match` };
    }
  }
}

// ---- score ---------------------------------------------------------------------------

export function scoreTranscript(t: Transcript, task: TaskSpec, maxCalls: number = MAX_TOOL_CALLS): Score {
  const events = eventsOf(t.calls);
  const reasons: string[] = [];
  const calls = t.calls.length <= maxCalls;
  if (!calls) reasons.push(`${t.calls.length} tool calls (max ${maxCalls})`);
  const discipline = [...checkDiscipline(events), ...truncatedRwOutputs(t.calls)];
  reasons.push(...discipline.map((d) => `discipline: ${d}`));
  const answer = t.final_answer.trim().length > 0;
  if (!answer) reasons.push("no final answer");
  const unbacked = unbackedNumbers(t.final_answer, numberSources(t.calls), [t.prompt]);
  if (unbacked.length) reasons.push(`numbers not in tool output: ${unbacked.join(", ")}`);
  const predicates = task.predicates.map((p) => ({ desc: p.desc, ...evalPredicate(p, t, events) }));
  for (const p of predicates) if (!p.pass) reasons.push(`incomplete: ${p.desc}${p.detail ? ` (${p.detail})` : ""}`);
  const gates = {
    calls,
    discipline: discipline.length === 0,
    numbers: unbacked.length === 0,
    predicates: predicates.every((p) => p.pass),
    answer,
  };
  return {
    task: task.id,
    pass: Object.values(gates).every(Boolean),
    tool_calls: t.calls.length,
    max_tool_calls: maxCalls,
    reasons,
    gates,
    discipline,
    unbacked_numbers: unbacked,
    predicates,
  };
}

// ---- Agent SDK messages → transcript ------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function blocks(msg: Rec): Rec[] {
  const m = msg["message"];
  const content = isRec(m) ? m["content"] : undefined;
  return Array.isArray(content) ? content.filter(isRec) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRec)
      .map((b) => (b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Builds the normalized transcript from the SDK message stream (`SDKMessage[]`). */
export function transcriptFromSdk(task: string, prompt: string, messages: readonly unknown[], files: readonly string[]): Transcript {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  let lastText = "";
  let result: string | null = null;
  for (const msg of messages) {
    if (!isRec(msg)) continue;
    if (msg["type"] === "assistant") {
      const texts: string[] = [];
      for (const b of blocks(msg)) {
        if (b["type"] === "tool_use") {
          const c: ToolCall = { id: str(b["id"]), tool: str(b["name"]), input: isRec(b["input"]) ? b["input"] : {}, output: "", is_error: false };
          calls.push(c);
          byId.set(c.id, c);
        } else if (b["type"] === "text" && typeof b["text"] === "string") {
          texts.push(b["text"]);
        }
      }
      if (texts.length) lastText = texts.join("\n");
    } else if (msg["type"] === "user") {
      for (const b of blocks(msg)) {
        if (b["type"] !== "tool_result") continue;
        const c = byId.get(str(b["tool_use_id"]));
        if (!c) continue;
        c.output = resultText(b["content"]);
        c.is_error = b["is_error"] === true;
      }
    } else if (msg["type"] === "result" && typeof msg["result"] === "string") {
      result = msg["result"];
    }
  }
  return { task, prompt, calls, final_answer: result ?? lastText, files: [...files].sort() };
}
