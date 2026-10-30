# Mock RPC server (M1.6b)

`app/packages/contracts/mock/server.ts` serves IF10 (`app/packages/contracts/src/rpc.ts`)
from `fixtures/contracts/`, so web work runs without the sidecar. It has no
dependencies: a minimal WebSocket endpoint (`mock/ws.ts`) on `node:http`.

```sh
pnpm --dir app --filter @rw/contracts mock [--port N] [--tick ms] [--script steps.json] [--demo] [--test-hooks]
# prints RW_RPC_URL=ws://127.0.0.1:<port>/rpc and RW_HTTP_URL=http://127.0.0.1:<port>
```

In tests, use `startMockServer({ tickMs, script, testHooks })` (port 0), or
`new MockRpc(opts).connect(send)` with no socket.

## Behaviour

- **Data.** Payloads are fixture copies. The mock changes only the fields a
  server owns: `model_hash`, step and revision numbers and ids, job and run
  states. One project, `research-vehicle`; `project.open` adds more with the
  same data. One seeded thread, `assembly-review`.
- **resources/updated.** A commit (UI `model.patch` or `history.restore`, an
  agent `model_patch`, a script `commit`) maps the sidecar URIs
  `rw://project/{model,check,files,history}` and `rw://runs/index` to snapshot
  keys and pushes one `project.patch` per subscription. Run status is
  recomputed from the hash (I7). Dry runs push nothing.
- **Jobs.** `sim.run` is served from cache when the run is current (and
  `force` is unset). Otherwise it starts a job that goes `queued`, then
  `running`, then `complete`, one tick apart, pushing `jobs` and `runs` at
  each step. `job.cancel` sets `cancelled` and restores the previous run entry.
- **Agent turns.** `thread.send` plays a scripted turn:
  - Text matching `/export|approv/i` plays a gated `export_file` call. It emits
    `approval_request` plus an `approval.request` push, then waits for
    `approval.respond`. Approve returns a result; reject returns an
    `isError` result.
  - Any other text plays an ungated `model_patch` (a commit and a step card).
    If a viewport host is registered, it then sends a `viewport_render`
    broker request.
  - `thread.interrupt` ends the turn as `interrupted`.
- **Broker and hooks.** `broker.hostRegister` and `broker.respond` work as in
  IF11. `test.call` returns `hooks_disabled` unless `testHooks` or
  `RW_TEST_HOOKS=1` (I12).
- **Series.** `GET /api/projects/:id/runs/:sim/:runId/series.csv` returns the
  `sim-result` fixture series, and `.../events.json` its events (`RunEvents`).
- **Scripts.** `ScriptStep[]` (`{afterMs, uris?, commit?, set?, sidecar?}`)
  play after the project's first `project.subscribe`. `--demo` plays an
  external edit, then a sidecar restart.

## Tests

`pnpm --filter @rw/contracts test mock` checks every frame against
`mock/rpc-schema.ts` (IF10 shapes) and the registry schemas. It uses
`schema/<type>.json` once M1.6 generates them, or `$RW_SCHEMA_DIR`. Until then
it checks each registry type against the shape of its contract fixtures; the
test titles show which mode ran.

When `rpc.ts` changes, update `rpc-schema.ts` in the same PR.
