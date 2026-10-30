# Contract fixtures

One schema-valid payload per frozen type (IF1 rocket, IF2-IF4, IF6-IF8, every
MCP tool input and output, and each oracle file kind), built on the research
vehicle tree. Numbers are illustrative, not simulation output.

Each file wraps its payload:

```json
{"provenance": "contract-fixture", "type": "<registry name>", "payload": {...}}
```

`type` is a `rw_api::schema_registry()` name, which is also the file stem under
`schema/`. The mock RPC server (M1.6b) and the sidecar doubles (M1.8) serve
`payload`. Nothing else may treat these as results.

Checks:

- `cargo test -p rw-api --test contract_fixtures`: every payload validates
  against its schema and deserializes into the Rust type, and every type that
  needs a fixture has one.
- `cargo test -p rw-api --test oracle_golden_schema`: the `oracle/` fixtures
  also pass the oracle valve rules (hashes, 200-char strings, unknown keys).

When a frozen type changes, update its fixture in the same PR (see
`docs/dev/contract-changes.md`).
