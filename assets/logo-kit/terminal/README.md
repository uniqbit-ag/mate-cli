# mate (Split Pane) in the terminal

| File | What it is | Block art (cols × rows) | ASCII (cols × rows) |
|---|---|---|---|
| `mate-lockup.*` | symbol + wordmark | 52 × 7 | 53 × 8 |
| `mate-symbol.*` | symbol, banner size | 14 × 7 | 14 × 8 |
| `mate-symbol-28col.*` | symbol, large (exactly 2×) | 28 × 14 | — |
| `mate-wordmark.*` | wordmark only | 34 × 6 | 35 × 7 |
| `mate-symbol-line.ascii.txt` | symbol in line characters | — | 15 × 6 |

Variants of each:

- `.dark.ans`: 24-bit colour for dark terminals (cream `#F4F0E8` + light green `#7FD0A6`).
- `.light.ans`: 24-bit colour for light terminals (ink `#1F2421` + green `#2E7D5B`).
- `.txt`: Unicode half-blocks (`█ ▀ ▄`) with no colour, so it uses the terminal's own text colour and works on any background.
- `.ascii.txt`: pure 7-bit ASCII, for logs, package registries, `--version` output and anywhere Unicode is unsafe.

Try them: `cat mate-lockup.dark.ans`

## Rules for CLI output
- Print the colour version only when stdout is a TTY and `NO_COLOR` is not set; otherwise print the `.txt` or `.ascii.txt` file.
- You can't reliably detect the terminal background. If unsure, use `.txt` and colour only the three note bars green, since both greens read on both backgrounds.
- For 256-colour terminals, use these approximations: ink 235, green 29, cream 255, light green 115.
- Block art assumes a monospace font whose `█` fills the whole cell (true for almost all terminal fonts). If a font leaves gaps, fall back to ASCII.
- Keep a blank line above and below the banner. Show it once (on `init` or `--help`), never on every command; a quiet tool is part of the brand.
