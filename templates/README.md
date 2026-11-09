# Project templates

`rw init --template <name> <dir>` copies one of these directories (plan M1.54c,
spec R3.1). Every template except `empty` is a complete project that evaluates
without diagnostics and flies on a RocketWright generic motor
(`lib/motors/generic/`). `empty` has no parts and no simulation, so it opens
cleanly but `rw check` reports `RW-E100` until parts are added.

| Template | Contents |
|---|---|
| `empty` | No parts, one configuration, no simulation |
| `minimum` | The smallest flyable project: nose, body, fins, motor mount, streamer, one configuration (RW_B4G) and simulation |
| `sample` | 54 mm research vehicle with a 24 mm motor mount: parachute, streamer, electronics bay, three configurations (RW_D10G, dual deploy, RW_A8G), flight and visual flow simulations, and a complete demo liquid engine that no configuration assigns |
| `simple-rocket` | 24.8 mm three-fin rocket: params, parachute, shock cord, engine block, centering rings, launch lug, a Baseline configuration (RW_C6G) and simulation, a stability assert |

Checks: `cargo test -p rw-model --test fixtures` (parse and evaluate clean in
every configuration), `cargo test -p rw-api --test fixtures` (motor fits,
static margin >= 1 cal, thrust-to-weight; not `empty`), `cargo test -p
rw-project --test fixtures_fmt` (`rw fmt` canonical).
