# Project templates

`rw init --template <name> <dir>` copies one of these directories (plan M1.54c,
spec R3.1). Each is a complete project that evaluates without diagnostics and
flies on a RocketWright generic motor (`lib/motors/generic/`).

| Template | Contents |
|---|---|
| `simple-rocket` | 24.8 mm three-fin rocket: params, parachute, shock cord, engine block, centering rings, launch lug, a Baseline configuration (RW_C6G) and simulation, a stability assert |
| `minimum` | The smallest flyable project: nose, body, fins, motor mount, streamer, one configuration (RW_B4G) and simulation |

Checks: `cargo test -p rw-model --test fixtures` (parse and evaluate clean in
every configuration), `cargo test -p rw-api --test fixtures` (motor fits,
static margin >= 1 cal, thrust-to-weight), `cargo test -p rw-project --test
fixtures_fmt` (`rw fmt` canonical).
