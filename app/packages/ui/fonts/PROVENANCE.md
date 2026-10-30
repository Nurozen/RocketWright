# Fonts

`JetBrainsMono-Regular.ttf` and `OFL.txt` are byte-identical copies from the
official JetBrains Mono 2.304 release archive
<https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip>
(`fonts/ttf/JetBrainsMono-Regular.ttf`, `OFL.txt`).

| File | sha256 |
|---|---|
| `JetBrainsMono-2.304.zip` | `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf` |
| `JetBrainsMono-Regular.ttf` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |

License: SIL Open Font License 1.1, no Reserved Font Name. Source only:
`scripts/gen-lecturn-theme.ts` subsets it (with Inter from
`app/apps/web/public/fonts/`) into `generated/fonts/*.subset.woff2`, which
`generated/lecturn-theme.json` embeds for the Lecturn pane (plan B11, D17).
