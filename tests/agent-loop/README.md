# B3 agent loop

- `kit.json`: the kit layout under `dist/kit/` (M2.11 builds it), the tools, the
  40-call limit, and the env. The runner fails if any listed file is missing.
- `tasks/T<n>.json`: one task each, with these fields.
  - `setup`: argv commands that seed the temp working directory, run with the kit on PATH.
  - `prompt`: the task text, with `{skill_doc}` and `{data:<key>}` placeholders.
  - `predicates`: completion predicates. The kinds are `sequence` (ordered steps over
    tool-call events), `file` (a working-directory path regex), `answer` (a final-answer
    regex), and `last_check`.

Runner, scorer, and rules: `docs/dev/bar-tooling.md` ("Agent loop (B3)").
