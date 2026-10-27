# mate — Split Pane logo usage guide

## The idea
One solid pane of finished work and a stack of three notes, with a clear gutter between them. The pane is the product's code; the notes are the AI's plans, specs and notes (the studio notebook). The gutter is the boundary mate keeps. The pair sits side by side like a split terminal window, which makes it native to the place the tool lives.

The symbol is built on a 16 × 16 grid. Every edge and gap falls on a whole grid square, so it converts to terminal art and small pixel sizes with no blur.

## Versions
| Version | File | Use |
|---|---|---|
| Horizontal lockup (primary) | `svg/mate-horizontal-*.svg` | README, website header, docs |
| Stacked lockup | `svg/mate-stacked-*.svg` | square spaces, stickers, slides |
| Symbol | `svg/mate-symbol-*.svg` | avatars, icons, anywhere the name is already nearby |
| Wordmark | `svg/mate-wordmark-*.svg` | inline text contexts where the symbol already appears |
| App icon / favicon | `svg/mate-app-icon.svg`, `web/` | OS icons, browser tabs |
| Terminal | `terminal/` | ANSI and ASCII art (see `terminal/README.md`) |

Every version comes in five colourways:

- `color`: for light backgrounds.
- `on-dark`: for dark backgrounds.
- `black` and `white`: one colour.
- `mono-green`: one colour in brand green.

The symbol is already heavy and grid-aligned, so it needs no separate small-size drawing.

## Colour
| Name | HEX | RGB | Role |
|---|---|---|---|
| Ink | `#1F2421` | 31 36 33 | product pane and wordmark on light |
| Mate green | `#2E7D5B` | 46 125 91 | the notes on light; one-colour brand version |
| Cream | `#F4F0E8` | 244 240 232 | product pane and wordmark on dark; warm light background |
| Light green | `#7FD0A6` | 127 208 166 | the notes on dark |
| Night | `#15191A` | 21 25 26 | dark background |

Contrast:

| Pair | Ratio |
|---|---|
| Green on white | 5.0 : 1 |
| Ink on white | 15.8 : 1 |
| Light green on night | 9.7 : 1 |
| Cream on night | 15.6 : 1 |

Approximate CMYK values: green C63 M0 Y27 K51, ink C14 M0 Y8 K86. Proof these before print, and match a Pantone from a physical swatch book rather than converting on screen.

Only the notes are ever green. If you can use only one colour, the whole logo goes in one colour.

## Clear space and size
- Let **x** be the height of the gaps between the notes. Keep at least **2x** clear on every side.
- Minimum sizes on screen:
  - Symbol: 16 px.
  - Horizontal lockup: 96 px wide.
  - Stacked lockup: 48 px wide.
- Minimum sizes in print:
  - Symbol: 6 mm.
  - Horizontal lockup: 25 mm.
- Terminal: the lockup needs 52 columns and the symbol needs 14. Below that, print the word `mate`.

## Don't
- Don't close the gutter or the gaps between the notes; they are the idea.
- Don't change the number of notes, swap the pane and notes, or mirror the symbol.
- Don't recolour the pane green, or use more than the two logo colours together.
- Don't add gradients, shadows, outlines or glows.
- Don't retype the wordmark in a font. The letters are custom-drawn paths, so use the SVG files.
- Don't place the colour version on mid-tone or busy backgrounds; switch to black or white instead.

## Known risk
Split rectangles are also a common "sidebar layout" icon in apps. The green notes and the fixed 2:1 proportion are what make this one Mate's. Keep them consistent so the mark builds recognition.

## Typography
The wordmark is the same custom-drawn geometric lettering as the Big & Little kit. It needs no font licence. For the text around the logo, a geometric or neo-grotesque sans (for example Inter or Geist) and a clean monospace for code fit the logo's quiet tone.

## Notes
- All master SVGs are pure filled paths, with no live text, strokes, gradients, masks or embedded images.
- The 16 px favicon (`web/icon-16.png`) is hand-placed pixel by pixel. The larger web icons are rendered from `mate-app-icon.svg`.
- A trademark search (trademark databases and a reverse image search) is recommended before launch.
