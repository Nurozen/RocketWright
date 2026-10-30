/** RL4: B3 agent-loop scorer and runner, on synthetic transcripts (no live agent). */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../bar/paths.ts";
import {
  checkDiscipline,
  checkOutcome,
  ownStrictChecks,
  evalPredicate,
  classifySegment,
  eventsOf,
  extractNumbers,
  isCalculator,
  numberSources,
  scoreTranscript,
  splitOps,
  splitSegments,
  transcriptFromSdk,
  redirectedAway,
  truncatedRwOutputs,
  unbackedNumbers,
  type TaskSpec,
  type ToolCall,
  type Transcript,
} from "../../../scripts/bar/agent-loop-score.ts";
import {
  archiveRenders,
  buildAgentOptions,
  pngArchive,
  listFiles,
  projectTexts,
  loadKit,
  loadTask,
  missingKitFiles,
  parseTaskList,
  renderPrompt,
  TASK_IDS,
} from "../../../scripts/bar/agent-loop.ts";

let n = 0;
const bash = (command: string, output: string, is_error = false): ToolCall => ({ id: `t${++n}`, tool: "Bash", input: { command }, output, is_error });
const read = (file_path: string, output: string): ToolCall => ({ id: `t${++n}`, tool: "Read", input: { file_path }, output, is_error: false });
const edit = (file_path: string, new_string: string): ToolCall => ({
  id: `t${++n}`,
  tool: "Edit",
  input: { file_path, old_string: "x", new_string },
  output: `The file ${file_path} has been updated.`,
  is_error: false,
});

const T1 = loadTask("T1");
const T2 = loadTask("T2");

const CHECK_OK = "check: 0 errors, 0 warnings\nstability.liftoff 1.84 cal\ncg 312.4 mm  cp 358.1 mm\n";
const SIM_OK = "sim baseline: motor RW_C6G\napogee_m 187.3\nmax_velocity_ms 52.61\ntime_to_apogee_s 6.42\n";

/** A clean T1 run: init, motor search, set motor, check, sim. */
function passingT1(): Transcript {
  return {
    task: "T1",
    prompt: T1.prompt,
    calls: [
      read("/kit/docs/rocketwright-model.md", "# RocketWright model\nRun rw check after every edit."),
      bash("rw motor search --class C", "RW_C6G  C6  18 mm  10.0 Ns  generic"),
      bash("rw init --template simple-rocket && rw check", `created rocketwright.toml\n${CHECK_OK}`),
      bash('rw set c.mount.motor="RW_C6G"', "set 1 field; step 2"),
      bash("rw check", CHECK_OK),
      bash("rw sim baseline", SIM_OK),
    ],
    final_answer: "The rocket is stable with a 1.84 cal margin (CG 312.4 mm, CP 358.1 mm). On the RW_C6G generic motor it reaches an apogee of 187.3 m at 6.42 s.",
    files: ["configs/default.rw.toml", "rocket.rw.toml", "rocketwright.toml", "sims/baseline.rw.toml"],
  };
}

describe("agent-loop scorer: synthetic transcripts", () => {
  it("a disciplined, complete T1 run passes", () => {
    const s = scoreTranscript(passingT1(), T1);
    expect(s.reasons).toEqual([]);
    expect(s.pass).toBe(true);
    expect(s.tool_calls).toBe(6);
    expect(s.gates).toEqual({ calls: true, discipline: true, numbers: true, predicates: true, answer: true });
  });

  it("a mutation with no check before the next mutation fails discipline", () => {
    const t = passingT1();
    // set motor, then edit the fins with no check in between.
    t.calls.splice(4, 0, edit("/tmp/w/rocket.rw.toml", 'span = "50 mm"'));
    const s = scoreTranscript(t, T1);
    expect(s.pass).toBe(false);
    expect(s.gates.discipline).toBe(false);
    expect(s.discipline).toHaveLength(1);
    expect(s.discipline[0]).toMatch(/call 4 \(Bash: rw set c\.mount\.motor=.*not checked before the next mutation, call 5 \(Edit/);
  });

  it("a mutation never checked before the answer fails discipline", () => {
    const t = passingT1();
    t.calls.push(bash('rw set params.fin_span.value="50 mm"', "set 1 field; step 3"));
    const s = scoreTranscript(t, T1);
    expect(s.gates.discipline).toBe(false);
    expect(s.discipline[0]).toMatch(/call 7 .* not checked before the final answer/);
  });

  it("a hand-computed number in the answer fails", () => {
    const t = passingT1();
    // 358.1 - 312.4 = 45.7, computed by the agent, never printed by a tool.
    t.final_answer += " The CP is 45.7 mm behind the CG.";
    const s = scoreTranscript(t, T1);
    expect(s.pass).toBe(false);
    expect(s.unbacked_numbers).toEqual(["45.7"]);
    expect(s.reasons).toContain("numbers not in tool output: 45.7");
  });

  it("a number computed with a shell calculator does not count as tool output", () => {
    const t = passingT1();
    t.calls.push(bash("python3 -c 'print(358.1-312.4)'", "45.7"));
    t.final_answer += " The CP is 45.7 mm behind the CG.";
    expect(scoreTranscript(t, T1).unbacked_numbers).toEqual(["45.7"]);
  });

  it("more than 40 tool calls fails", () => {
    const t = passingT1();
    for (let i = 0; i < 35; i++) t.calls.splice(1, 0, bash("rw eval c.fins.span", "45 mm"));
    expect(t.calls).toHaveLength(41);
    const s = scoreTranscript(t, T1);
    expect(s.pass).toBe(false);
    expect(s.gates.calls).toBe(false);
    expect(s.reasons[0]).toBe("41 tool calls (max 40)");
    // Exactly 40 is allowed.
    t.calls.splice(1, 1);
    expect(scoreTranscript(t, T1).gates.calls).toBe(true);
  });

  it("an unfinished task fails its completion predicates", () => {
    const t = passingT1();
    t.calls = t.calls.filter((c) => !String(c.input["command"]).includes("rw sim"));
    t.final_answer = "The rocket is stable with a 1.84 cal margin.";
    const s = scoreTranscript(t, T1);
    expect(s.gates.predicates).toBe(false);
    expect(s.reasons).toContain("incomplete: a clean check, then a successful sim (step 2 of 2 not found)");
    expect(s.reasons).toContain("incomplete: the answer reports the apogee (answer lacks /apogee/)");
  });

  it("T2: shrink, failing check with a hint, fix, clean check passes", () => {
    const fail = "RW-E101 error rocket.rw.toml /c/fins/span: static margin 0.42 cal < 1 cal (hint: increase fin span or move mass forward)\nExit code 1";
    const t: Transcript = {
      task: "T2",
      prompt: T2.prompt,
      calls: [
        bash("rw check", CHECK_OK),
        bash('rw set params.fin_span.value="25 mm" && rw check', `set 1 field\n${fail}`, true),
        bash('rw set params.fin_span.value="45 mm"', "set 1 field"),
        bash("rw check", CHECK_OK),
      ],
      final_answer: "Shrinking the fins to 25 mm gave RW-E101 with the hint to increase fin span or move mass forward (margin 0.42 cal). Back at 45 mm the margin is 1.84 cal.",
      files: ["rocketwright.toml"],
    };
    const s = scoreTranscript(t, T2);
    expect(s.reasons).toEqual([]);
    expect(s.pass).toBe(true);
  });
});

describe("agent-loop scorer: parsing", () => {
  it("splits shell commands on separators, keeping quotes and heredocs", () => {
    expect(splitSegments('rw set a="x; y" && rw check || echo no; ls | wc -l')).toEqual(['rw set a="x; y"', "rw check", "echo no", "ls", "wc -l"]);
    expect(splitSegments("cat > rocket.rw.toml <<'EOF'\nrw check\nEOF\nrw check 2>&1")).toEqual(["cat > rocket.rw.toml <<'EOF'\nrw check\nEOF", "rw check 2>&1"]);
    expect(splitSegments("rw set a=1 \\\n  b=2")).toEqual(["rw set a=1   b=2"]);
  });

  it("classifies mutations and checks", () => {
    const k = (s: string) => classifySegment(s);
    expect(k("rw check --strict")).toEqual({ mutation: false, check: true });
    expect(k("RW_X=1 /kit/bin/rocketwright --json -C proj check")).toEqual({ mutation: false, check: true });
    expect(k("rw call design_check '{}'")).toEqual({ mutation: false, check: true });
    for (const m of ["rw init", 'rw set c.fins.span="30 mm"', "rw add chute @c.json", "rw rm chute", "rw mv lug body.mid", "rw import ork a.ork", "rw call model_patch '{}'", "rw call --label x component_add '{}'"]) {
      expect(k(m).mutation, m).toBe(true);
    }
    for (const r of ["rw set a=1 --dry-run", "rw eval", "rw sim baseline", "rw render --view iso", "rw history log", "rw set --help", "rw call model_patch '{\"dry_run\": true}'", "rw motor search"]) {
      expect(k(r).mutation, r).toBe(false);
    }
    for (const m of ["cat > rocket.rw.toml", "echo x >> configs/a.rw.toml", "tee rocket.rw.toml", "sed -i '' s/a/b/ rocket.rw.toml", "cp /tmp/x.toml rocket.rw.toml"]) {
      expect(k(m).mutation, m).toBe(true);
    }
    expect(k("cat rocket.rw.toml").mutation).toBe(false);
    expect(k("sed -n 1,5p rocket.rw.toml").mutation).toBe(false);
  });

  it("counts an rw edit that exits 1 with design errors; ignores a rejected one", () => {
    const applied = bash('rw set c.fins.span="5 mm"', "recorded step:2\n  M rocket.rw.toml\ncheck: errors\nExit code 1", true);
    const rejected = bash("rw set bogus.x=1", "Error: op 0 at `/bogus/x`: not_found\nExit code 2", true);
    expect(eventsOf([applied]).map((e) => e.mutation)).toEqual([true]);
    expect(eventsOf([rejected]).map((e) => e.mutation)).toEqual([false]);
    expect(checkDiscipline(eventsOf([rejected, applied, bash("rw check", CHECK_OK)]))).toEqual([]);
    expect(checkDiscipline(eventsOf([applied, applied]))).toHaveLength(2);
  });

  it("ignores edits of a failed call without a check, and non-toml writes", () => {
    const ev = eventsOf([
      bash("rw set bogus=1", "RW-E001 error: unknown path\nExit code 1", true),
      { id: "w", tool: "Write", input: { file_path: "/w/notes.md", content: "x" }, output: "ok", is_error: false },
    ]);
    expect(ev.map((e) => e.mutation)).toEqual([false, false]);
    expect(checkDiscipline(ev)).toEqual([]);
  });

  it("extracts numbers outside identifiers", () => {
    expect(extractNumbers("RW-E101 C6 case1 step 2: 187.3 m, -0.5 cal, 1,234 g, 3.2e-2, 18mm, v0.3.301")).toEqual(["2", "187.3", "-0.5", "1,234", "3.2e-2", "18"]);
  });

  it("backs numbers quoted at the printed precision and exempts small integers and prompt numbers", () => {
    expect(unbackedNumbers("apogee 187.34 m, 187.340 m, 0.032, 1234 g, step 3", ["apogee_m 187.34\nx 3.2e-2\nm 1,234"])).toEqual([]);
    expect(unbackedNumbers("apogee 188 m", ["apogee_m 187.34"])).toEqual(["188"]);
    expect(unbackedNumbers("delta -12.5 m", ["delta +12.5"])).toEqual([]);
    // B3 round 8: trailing zeros are ignored both ways.
    expect(unbackedNumbers("margin 2.75 cal, mass 72.0 g", ["stability.liftoff 2.7500 cal\nmass 72 g"])).toEqual([]);
    // M2.11 B3 round 5: a render size `(1600x900)` backs "1600×900".
    expect(unbackedNumbers("iso view (1600×900)", ["renders/default.iso.png (1600x900)"])).toEqual([]);
    expect(unbackedNumbers("target 300 m", [], ["reaches about 300 m"])).toEqual([]);
  });

  it("a correct rounding of a printed number to fewer decimals is backed (B3 round 11, D28)", () => {
    // Half-up and banker's rounding, to fewer decimals or to an integer.
    expect(unbackedNumbers("apogee 187.3 m", ["apogee_m 187.34"])).toEqual([]);
    expect(unbackedNumbers("apogee 187 m", ["apogee_m 187.34"])).toEqual([]);
    expect(unbackedNumbers("vmax 52.6 m/s", ["max_velocity_ms 52.61"])).toEqual([]);
    expect(unbackedNumbers("margin 0.43 cal", ["stability 0.4321 cal"])).toEqual([]);
    expect(unbackedNumbers("half-up 0.3, banker's 0.2", ["x 0.25"])).toEqual([]);
    expect(unbackedNumbers("2.4 and 2.5", ["x 2.45"])).toEqual([]);
    expect(unbackedNumbers("187.30 m", ["apogee 187.304 m"])).toEqual([]);
    expect(unbackedNumbers("0.03", ["x 3.2e-2"])).toEqual([]);
    expect(unbackedNumbers("1,235 g", ["mass 1,234.5 g"])).toEqual([]);
    // Round 11 T5: the static deltas of `rw diff run --golden`, rounded.
    const diff = "mass.cg 261.69 mm 261.59 mm +0.10505 mm +0.04\naero.cp 330.56 mm 330.4 mm +0.15801 mm\nstability.liftoff +0.0021085 cal\ntime_to_apogee_s -0.024496 s\napogee_m +1.7921 m";
    expect(unbackedNumbers("CG +0.11 mm, CP +0.16 mm, stability +0.0021 cal, 1.79 m higher, apogee 0.024 s sooner", [diff])).toEqual([]);
    // A range is checked end by end.
    expect(unbackedNumbers("stability 3.6-3.9 cal", ["min 3.6123 cal\nmax 3.8877 cal"])).toEqual([]);
    expect(unbackedNumbers("stability 3.6–3.9 cal", ["min 3.6123 cal\nmax 3.8877 cal"])).toEqual([]);
    expect(unbackedNumbers("stability 3.6-4.0 cal", ["min 3.6123 cal\nmax 3.8877 cal"])).toEqual(["4.0"]);
  });

  it("truncations, wrong roundings, sign flips, and derived values stay unbacked (D28)", () => {
    // Truncated (52.68 rounds to 52.7), rounded the wrong way, rounded to tens.
    expect(unbackedNumbers("vmax 52.6 m/s", ["max_velocity_ms 52.68"])).toEqual(["52.6"]);
    expect(unbackedNumbers("apogee 188 m", ["apogee_m 187.34"])).toEqual(["188"]);
    expect(unbackedNumbers("apogee 190 m", ["apogee_m 187.34"])).toEqual(["190"]);
    // More decimals than printed is not a rounding.
    expect(unbackedNumbers("apogee 187.30 m", ["apogee_m 187.34"])).toEqual(["187.30"]);
    // A written sign must match the printed one.
    expect(unbackedNumbers("CG -0.11 mm", ["mass.cg +0.10505 mm"])).toEqual(["-0.11"]);
    expect(unbackedNumbers("Δt +0.024 s", ["time_to_apogee_s -0.024496 s"])).toEqual(["+0.024"]);
    // Derived figures: a unit conversion, a difference, a ratio.
    expect(unbackedNumbers("CG at 312.3 mm", ["cg 0.3123 m"])).toEqual(["312.3"]);
    expect(unbackedNumbers("CP is 45.7 mm aft of the CG", ["cg 312.4 mm\ncp 358.1 mm"])).toEqual(["45.7"]);
    expect(unbackedNumbers("CP is 46 mm aft of the CG", ["cg 312.4 mm\ncp 358.1 mm"])).toEqual(["46"]);
    expect(unbackedNumbers("thrust to weight 8.44 → 1.15 times", ["T/W 8.4438\nT/W 7.3421"])).toEqual(["1.15"]);
  });

  it("a T1 answer that rounds printed numbers passes, one that derives a number fails (B3 round 11)", () => {
    const t = passingT1();
    // SIM_OK prints apogee_m 187.3 and time_to_apogee_s 6.42.
    t.final_answer = t.final_answer.replace("187.3 m at 6.42 s", "187 m at 6.4 s");
    let s = scoreTranscript(t, T1);
    expect(s.unbacked_numbers).toEqual([]);
    expect(s.gates.numbers).toBe(true);
    expect(s.pass).toBe(true);
    // CP - CG (358.1 - 312.4), rounded or not, is a derived value.
    t.final_answer = "Stable at 1.84 cal (CP 45.7 mm aft of the CG, about 46 mm); apogee 187.3 m at 6.42 s.";
    s = scoreTranscript(t, T1);
    expect(s.pass).toBe(false);
    expect(s.gates.numbers).toBe(false);
    expect(s.unbacked_numbers).toEqual(["45.7", "46"]);
    expect(s.reasons).toContain("numbers not in tool output: 45.7, 46");
  });

  it("drops calculator and Write/Edit outputs from number sources, keeps written design values", () => {
    expect(isCalculator("echo $((3+4))")).toBe(true);
    // M2.11 B3 round 5: status echoes do not hide the call's rw output.
    expect(isCalculator('echo "EXIT=$?"')).toBe(false);
    expect(isCalculator("echo ---")).toBe(false);
    expect(isCalculator('echo "== span $s"')).toBe(false);
    expect(isCalculator('echo "=== config 5d9a ==="')).toBe(false);
    expect(isCalculator("echo 357.9")).toBe(true);
    expect(isCalculator("printf '%.1f' 0.35792")).toBe(true);
    expect(isCalculator('echo "$(rw eval c.fins.span)"')).toBe(true);
    expect(isCalculator("jq '.apogee_m' runs/x/summary.json")).toBe(false);
    expect(isCalculator("jq '.a - .b' s.json")).toBe(true);
    const src = numberSources([
      bash("rw sim b", "apogee_m 187.3"),
      bash("awk '{print $1*2}' f", "374.6"),
      edit("/w/a.toml", "x = 99.9"),
      edit("/w/notes.md", "y = 12.5"),
    ]);
    expect(src).toEqual(["rw sim b", "apogee_m 187.3", "x = 99.9"]);
  });
});

describe("agent-loop: T3 file predicates on real project text", () => {
  it("finds an anchored parachute in the simple-rocket template, and no rail button", () => {
    const T3 = loadTask("T3");
    const text = readFileSync(join(REPO_ROOT, "templates/simple-rocket/rocket.rw.toml"), "utf8");
    const t: Transcript = { task: "T3", prompt: "", calls: [], final_answer: "", files: ["rocket.rw.toml"], file_texts: { "rocket.rw.toml": text } };
    const [chute, rail] = T3.predicates;
    expect(evalPredicate(chute!, t, []).pass).toBe(true);
    expect(evalPredicate(rail!, t, []).pass).toBe(false);
    const withRail = text + '\n[c.rb]\ntype = "rail_button"\nattach = { to = "body.mid", at = "aft" }\n';
    expect(evalPredicate(rail!, { ...t, file_texts: { "rocket.rw.toml": withRail } }, []).pass).toBe(true);
    // Unattached: no `attach` in its own table.
    const loose = text + '\n[c.rb]\ntype = "rail_button"\nod = "5 mm"\n';
    expect(evalPredicate(rail!, { ...t, file_texts: { "rocket.rw.toml": loose } }, []).pass).toBe(false);
  });
});

describe("agent-loop: SDK messages to transcript", () => {
  it("pairs tool_use with tool_result and takes the result text as the answer", () => {
    const msgs = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "a", name: "Bash", input: { command: "rw check" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "Exit code 1\nRW-E101 ..." }], is_error: true }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Read", input: { file_path: "/x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "line" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done: margin 1.84 cal." }] } },
      { type: "result", subtype: "success", result: "Done: margin 1.84 cal." },
    ];
    const t = transcriptFromSdk("T1", "p", msgs, ["b", "a"]);
    expect(t.calls).toEqual([
      { id: "a", tool: "Bash", input: { command: "rw check" }, output: "Exit code 1\nRW-E101 ...", is_error: true },
      { id: "b", tool: "Read", input: { file_path: "/x" }, output: "line", is_error: false },
    ]);
    expect(t.final_answer).toBe("Done: margin 1.84 cal.");
    expect(t.files).toEqual(["a", "b"]);
    // No result message: the last assistant text.
    expect(transcriptFromSdk("T1", "p", msgs.slice(0, -1), []).final_answer).toBe("Done: margin 1.84 cal.");
  });
});

describe("agent-loop runner", () => {
  const kit = loadKit();

  it("isolates the agent: temp cwd, no settings, strict empty MCP, four tools, only the kit on PATH", () => {
    const o = buildAgentOptions(kit, "/kit", "/tmp/rw-b3-T1-x", {
      PATH: "/opt/homebrew/bin:/Users/u/.cargo/bin:/usr/bin",
      HOME: "/h",
      ELECTRON_RUN_AS_NODE: "1",
      RW_RENDER: "/repo/bin/rocketwright-render",
      CARGO_TARGET_DIR: "/repo/target",
      CLAUDECODE: "1",
    });
    expect(o.cwd).toBe("/tmp/rw-b3-T1-x");
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({});
    expect(o.tools).toEqual(["Bash", "Read", "Write", "Edit"]);
    expect(o.allowedTools).toEqual(o.tools);
    expect(o.permissionMode).toBe("default");
    // Only the kit and the system dirs: nothing from the builder's PATH.
    expect(o.env["PATH"]).toBe("/kit/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(o.env["RW_RENDER"]).toBeUndefined();
    expect(o.env["CARGO_TARGET_DIR"]).toBeUndefined();
    expect(o.env["CLAUDECODE"]).toBeUndefined();
    expect(o.env["HOME"]).toBe("/h");
    expect(o.env["RW_OFFLINE"]).toBe("1");
    expect(o.env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    expect(o.model).toBeUndefined();
    expect(kit.max_tool_calls).toBe(40);
  });

  it("loads all five tasks and fills every prompt placeholder", () => {
    for (const id of TASK_IDS) {
      const t: TaskSpec = loadTask(id);
      expect(t.id).toBe(id);
      expect(t.predicates.length).toBeGreaterThan(0);
      const p = renderPrompt(t, kit, "/kit");
      expect(p).not.toMatch(/\{[\w:-]+\}/);
      expect(p).toContain("/kit/docs/rocketwright-model.md");
      for (const pr of t.predicates) {
        const pats = pr.kind === "sequence" ? pr.steps.flatMap((s) => [s.input, s.output, s.not_output, s.text]) : pr.kind === "last_check" ? [pr.not_output] : pr.kind === "file" ? [pr.pattern, pr.contains] : [pr.pattern];
        for (const pat of pats) if (pat !== undefined) expect(() => new RegExp(pat, "i")).not.toThrow();
      }
    }
    expect(renderPrompt(loadTask("T5"), kit, "/kit")).toContain("/kit/data/A simple model rocket.ork");
  });

  it("parses task lists", () => {
    expect(parseTaskList("T1..T5")).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(parseTaskList("T2..T3")).toEqual(["T2", "T3"]);
    expect(parseTaskList("T4,T1")).toEqual(["T4", "T1"]);
    expect(parseTaskList("all")).toHaveLength(5);
    expect(parseTaskList("T6")).toBeNull();
    expect(parseTaskList("T3..T1")).toBeNull();
  });

  it("names every missing kit file", () => {
    const root = mkdtempSync(join(tmpdir(), "rw-kit-"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/rw"), "");
    const missing = missingKitFiles(kit, root);
    expect(missing).toContain(join(root, "bin/rocketwright"));
    expect(missing).toContain(join(root, "data/case1-generic.json"));
    expect(missing).not.toContain(join(root, "bin/rw"));
  });

  it("lists working-directory files without .rw/", () => {
    const d = mkdtempSync(join(tmpdir(), "rw-wd-"));
    mkdirSync(join(d, ".rw/threads"), { recursive: true });
    mkdirSync(join(d, "renders"));
    writeFileSync(join(d, ".rw/threads/a.jsonl"), "");
    writeFileSync(join(d, "renders/default.iso.png"), "");
    writeFileSync(join(d, "rocketwright.toml"), "");
    expect(listFiles(d)).toEqual(["renders/default.iso.png", "rocketwright.toml"]);
    expect(projectTexts(d, listFiles(d))).toEqual({ "rocketwright.toml": "" });
  });

  it("archives every PNG the agent rendered or Read (B3 round 8)", () => {
    const d = mkdtempSync(join(tmpdir(), "rw-wd-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "rw-elsewhere-"));
    // A project in a subdirectory, plus the working directory's own renders/.
    mkdirSync(join(d, "rocket/renders"), { recursive: true });
    mkdirSync(join(d, "renders"));
    writeFileSync(join(d, "rocket/renders/baseline.profile.png"), "p1");
    writeFileSync(join(d, "rocket/renders/baseline.profile.svg"), "<svg/>");
    writeFileSync(join(d, "renders/default.iso.png"), "p2");
    writeFileSync(join(d, "shot.png"), "p3");
    writeFileSync(join(d, "rocket/rocket.rw.toml"), "");
    mkdirSync(join(elsewhere, "a"));
    writeFileSync(join(elsewhere, "view.png"), "p4");
    writeFileSync(join(elsewhere, "a/view.png"), "p5");
    const files = listFiles(d);
    const calls = [
      read(join(elsewhere, "view.png"), "[image]"),
      read(join(elsewhere, "a/view.png"), "[image]"),
      read("rocket/renders/baseline.profile.png", "[image]"),
      read(join(elsewhere, "missing.png"), "File does not exist."),
      read(join(d, "rocket/rocket.rw.toml"), ""),
    ];
    expect(pngArchive(d, files, calls).map((a) => a.dest)).toEqual([
      "default.iso.png",
      "rocket/renders/baseline.profile.png",
      "rocket/renders/baseline.profile.svg",
      "shot.png",
      "read/view.png",
      "read/view-2.png",
    ]);
    const out = mkdtempSync(join(tmpdir(), "rw-out-"));
    expect(archiveRenders(d, files, calls, out)).toHaveLength(6);
    expect(readFileSync(join(out, "renders/rocket/renders/baseline.profile.png"), "utf8")).toBe("p1");
    expect(readFileSync(join(out, "renders/default.iso.png"), "utf8")).toBe("p2");
    expect(readFileSync(join(out, "renders/read/view.png"), "utf8")).toBe("p4");
    expect(readFileSync(join(out, "renders/read/view-2.png"), "utf8")).toBe("p5");
  });
});

describe("agent-loop: check outcome from the check's own output (B3 round 5)", () => {
  it("reads the last status line, and warnings fail only under --strict", () => {
    expect(checkOutcome("rw check --strict", "check: clean (static) config baseline\n")).toBe(true);
    expect(checkOutcome("rw check --strict", "check: errors (static) config baseline\n  RW-E101 error ...")).toBe(false);
    expect(checkOutcome("rw check --strict", "check: warnings (static)\n")).toBe(false);
    expect(checkOutcome("rw check", "check: warnings (static)\n")).toBe(true);
    expect(checkOutcome("rw check --json", '{"status": "errors", "diagnostics": []}')).toBe(false);
    expect(checkOutcome("rw check", "== span 25\ncheck: errors\n== span 30\ncheck: clean\n")).toBe(true);
    expect(checkOutcome("rw check", "no status here")).toBeNull();
  });

  it("a failing check followed by `echo EXIT=$?` is a failed check event", () => {
    const out = "check: errors (static) config baseline\n  RW-E101 error /c/fins/span: Unstable (hint: Move the CP aft.)\nEXIT=1";
    const ev = eventsOf([bash('rw check --strict; echo "EXIT=$?"', out)]);
    expect(ev[0]).toMatchObject({ check: true, ok: false });
    // The echo segment itself keeps the call status.
    expect(ev[1]).toMatchObject({ check: false, ok: true });
  });
});

describe("agent-loop: rejected rw edits (B3 round 5)", () => {
  it("an rw edit that fails with error: and records no step is not a mutation", () => {
    const out = "error: op 0 at `/configs/default/deploy/chute/event`: not_found\nhint: ...\nexit=2";
    const ev = eventsOf([bash('rw set configs.default.deploy.chute.event=ejection; echo "exit=$?"', out)]);
    expect(ev[0]).toMatchObject({ mutation: false, ok: false });
    const done = eventsOf([bash('rw set c.fins.span="30 mm"; echo "exit=$?"', "recorded step:2\n  M rocket.rw.toml\ndelta: clean\nexit=0")]);
    expect(done[0]).toMatchObject({ mutation: true });
  });
});

describe("agent-loop: an rw edit's own strict check (B3 round 5)", () => {
  const strictOut = (status: string) =>
    `recorded step:2\n  M rocket.rw.toml\ndelta: clean (lenient)\ncheck --strict: ${status} (static) config baseline\n  length 563 mm, diameter 24.8 mm\n`;

  it("reads each check --strict section (text) and check_strict_status (JSON)", () => {
    expect(ownStrictChecks(strictOut("clean"))).toEqual([true]);
    expect(ownStrictChecks(strictOut("warnings"))).toEqual([false]);
    expect(ownStrictChecks(`${strictOut("clean")}${strictOut("errors")}`)).toEqual([true, false]);
    expect(ownStrictChecks('{"step": "step:2", "check_strict_status": "clean"}')).toEqual([true]);
    // `rw check --strict` prints `check: <status>`, not a section of an edit.
    expect(ownStrictChecks("check: clean (static)\n")).toEqual([]);
  });

  it("an edit's clean section counts as the check that follows it", () => {
    const ev = eventsOf([bash('rw set c.fins.span="50 mm"', strictOut("clean")), bash('rw set c.fins.span="55 mm"', strictOut("clean"))]);
    expect(ev.map((e) => [e.mutation, e.check, e.ok])).toEqual([
      [true, false, true],
      [false, true, true],
      [true, false, true],
      [false, true, true],
    ]);
    expect(checkDiscipline(ev)).toEqual([]);
  });

  it("a failing section is a failed check; two edits in one call take one section each", () => {
    const fail = eventsOf([bash('rw set c.fins.span="1 mm"; echo "exit=$?"', `${strictOut("errors")}  RW-E101 error /c/fins/span: Unstable (hint: Move the CP aft.)\nexit=1`)]);
    expect(fail[1]).toMatchObject({ check: true, ok: false });
    const two = eventsOf([bash('rw set a=1 && rw add x "{}"', `${strictOut("clean")}${strictOut("warnings")}`)]);
    expect(two.filter((e) => e.check).map((e) => e.ok)).toEqual([true, false]);
    expect(checkDiscipline(two)).toEqual([]);
  });

  it("an edit whose section was cut off by `| head` still needs rw check", () => {
    const ev = eventsOf([bash('rw set c.fins.span="50 mm" | head -2', "recorded step:2\n  M rocket.rw.toml\n"), bash('rw set c.fins.span="55 mm"', strictOut("clean"))]);
    expect(checkDiscipline(ev)).toHaveLength(1);
    // A file edit has no section of its own.
    const file = eventsOf([edit("/w/rocket.rw.toml", 'span = "50 mm"')]);
    expect(checkDiscipline(file)).toHaveLength(1);
  });
});

describe("agent-loop: rw edits and checks piped through head/tail (B3 round 12)", () => {
  const strictOut = "recorded step:2\n  M rocket.rw.toml\ndelta: clean (lenient)\ncheck --strict: clean (static) config baseline\n";

  it("keeps the operator after each segment", () => {
    expect(splitOps('rw set a=1 2>&1 | tail -20; echo "x" && rw check |& head')).toEqual([
      { seg: "rw set a=1 2>&1", op: "|" },
      { seg: "tail -20", op: ";" },
      { seg: 'echo "x"', op: "&&" },
      { seg: "rw check", op: "|&" },
      { seg: "head", op: "" },
    ]);
  });

  it("flags rw edits, mutating rw calls, and rw check cut by head or tail", () => {
    const calls = [
      bash('rw set params.fin_span.value="25 mm" --label "trim" 2>&1 | tail -25', strictOut),
      bash('rw check --strict --set c.fins.span="40 mm" 2>&1 | tail -20', "check: clean (static)\n"),
      bash("rw call model_patch '{\"ops\":[]}' 2>&1 | tail -20; echo \"exit=$?\"", '{"step": "step:4"}'),
      bash('rw add lug "{}" | grep -v x | head -5', strictOut),
      bash("rw call design_check '{}' | head", '{"status": "clean"}'),
    ];
    const v = truncatedRwOutputs(calls);
    expect(v).toHaveLength(5);
    expect(v[0]).toMatch(/^call 1 \(Bash: rw set .*\) pipes the rw edit through tail/);
    expect(v[1]).toMatch(/^call 2 .* pipes rw check through tail/);
    expect(v[2]).toMatch(/^call 3 .* pipes the rw edit through tail/);
    expect(v[3]).toMatch(/^call 4 .* through head/);
    expect(v[4]).toMatch(/^call 5 .* pipes rw call through head/);
  });

  it("leaves reads, dry runs, unpiped edits, and other filters alone", () => {
    const calls = [
      bash("rw --help 2>&1 | head -50", "Usage: rw"),
      bash("rw motor search --class C | head -40", "generic:RW_C6G"),
      bash('rw set c.fins.span="30 mm" --dry-run | tail -5', "dry run"),
      bash("rw sim baseline | tail -3", "apogee 393 m"),
      bash('rw set c.fins.span="30 mm"; tail -5 notes.txt', strictOut),
      bash("rw check --strict | grep stability", "stability liftoff 3.864 cal"),
      bash("cat rocket.rw.toml | head -20", "[c.body]"),
    ];
    expect(truncatedRwOutputs(calls)).toEqual([]);
  });

  it("flags rw edits and checks whose output is redirected away (B3 round 13)", () => {
    const calls = [
      bash(`rw call model_patch '{"ops":[{"op":"remove","path":"/sims/s/launch_into_wind"}]}' >/dev/null; echo "exit=$?"`, "exit=0"),
      bash('rw set c.fins.span="30 mm" > /tmp/out.txt', ""),
      bash("rw check --strict &>/dev/null && echo ok", "ok"),
      bash("rw rm sims.s.launch_into_wind 2>/dev/null", strictOut),
      bash("rw set a=1 | cat > /dev/null", ""),
      bash("rw add lug '{}' >&-", ""),
    ];
    const v = truncatedRwOutputs(calls);
    expect(v).toHaveLength(6);
    expect(v[0]).toMatch(/^call 1 \(Bash: rw call model_patch .*\) redirects the rw edit's output away \(>\/dev\/null\)/);
    expect(v[1]).toMatch(/^call 2 .* away \(> \/tmp\/out.txt\)/);
    expect(v[2]).toMatch(/^call 3 .* redirects rw check's output away \(&>\/dev\/null\)/);
    expect(v[3]).toMatch(/^call 4 .* \(2>\/dev\/null\)/);
    expect(v[4]).toMatch(/^call 5 .* away \(\| cat > \/dev\/null\)/);
    expect(v[5]).toMatch(/^call 6 .* \(>&-\)/);
  });

  it("keeps redirections that leave the output in view", () => {
    const calls = [
      bash('rw set c.fins.span="30 mm" 2>&1', strictOut),
      bash("rw check --strict >&2", "check --strict: clean"),
      bash('rw set c.fins.span="30 mm" | tee step.txt', strictOut),
      bash("rw sim baseline > sim.txt", ""),
      bash("rw render --view profile >/dev/null", ""),
      bash(`rw set c.n.label="a > b" 2>&1`, strictOut),
      bash("rw set c.fins.span=\"30 mm\" --dry-run >/dev/null", ""),
    ];
    expect(truncatedRwOutputs(calls)).toEqual([]);
    expect(redirectedAway("rw set a=1 >/dev/null 2>&1")).toBe(">/dev/null");
    expect(redirectedAway("rw set a=1 2>/dev/null", true)).toBeNull();
    expect(redirectedAway("cat <<'EOF' > x\n> not a redirect\nEOF")).toBe("> x");
  });

  it("fails the discipline gate even when the cut kept the strict section", () => {
    const t = passingT1();
    expect(scoreTranscript(t, T1).pass).toBe(true);
    t.calls.splice(4, 1, bash("rw check 2>&1 | tail -20", CHECK_OK));
    const s = scoreTranscript(t, T1);
    expect(s.gates.discipline).toBe(false);
    expect(s.discipline).toEqual([expect.stringMatching(/^call 5 \(Bash: rw check 2>&1\) pipes rw check through tail/)]);
    expect(s.pass).toBe(false);
  });
});
