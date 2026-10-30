# Vendored fonts

Inter 4.1, unmodified, from the upstream release archive
<https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip>
(sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`),
files `extras/ttf/Inter-Regular.ttf`, `extras/ttf/Inter-SemiBold.ttf`, and
`LICENSE.txt` (copied here as `OFL.txt`). License: SIL Open Font License 1.1.

| File | sha256 |
|---|---|
| `Inter-Regular.ttf` | `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82` |
| `Inter-SemiBold.ttf` | `78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3` |
| `OFL.txt` | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |

The fonts are embedded in the `rocketwright` binary with `include_bytes!`
(`crates/rw-cli/src/render2d.rs`). Changing them changes the golden PNG hash
in that module's tests.
