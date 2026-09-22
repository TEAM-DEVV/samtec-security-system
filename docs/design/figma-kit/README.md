# SAMTEC Figma kit

Ten artboards of the SAMTEC dashboard, drawn to match the real app (the navy
and gold come from the favicon; the layout mirrors `apps/web`). They are SVG
files because that is the one format Figma imports as **fully editable
design** — every text, colour and shape becomes a real Figma layer you can
restyle. (Figma's own `.fig` format is closed; no outside tool can write it.)

| File | Frame | Size |
|---|---|---|
| `00-design-system.svg` | Colours, type scale, components | 1440 × 900 |
| `01-sign-in.svg` | Sign-in page | 1440 × 1024 |
| `02-two-factor-setup.svg` | Two-factor setup (QR + code) | 1440 × 1024 |
| `03-overview.svg` | Overview home page (light) | 1440 × 1024 |
| `04-overview-dark.svg` | Overview home page (dark) | 1440 × 1024 |
| `05-employees.svg` | Employees list | 1440 × 1024 |
| `06-employee-record.svg` | Employee record | 1440 × 1024 |
| `07-sites.svg` | Sites list | 1440 × 1024 |
| `08-mobile-overview.svg` | Overview on a phone | 390 × 844 |
| `09-mobile-menu.svg` | Phone menu (sheet open) | 390 × 844 |

All names, phone numbers and Ghana Card numbers are fictional (the same demo
people as the seed data).

## Import into Figma (2 minutes)

1. In Figma, create a new **Design file** (`figma.com` or the desktop app).
2. Select **all ten SVG files** in this folder and **drag them onto the
   canvas** in one go (or File → *Place image* also accepts SVG). Each file
   arrives as one group.
3. Select each group and press **Ctrl + Alt + G** (*Frame selection*) so it
   becomes a proper frame, then name the frames `01 Sign in`, `02 Two-factor
   setup`, … following the file names. Frames are what prototyping connects.
4. Fonts: the text imports asking for **Geist** (what the real app uses) with
   **Inter** as the stand-in and **JetBrains Mono** for codes — all three are
   free Google Fonts that Figma already has. If Figma shows a *missing fonts*
   dialog, choose *Replace* with Inter and Inter → done.

## Wire the prototype (5 minutes)

Switch to the **Prototype** tab on the right, then drag a connection arrow
from each hotspot to its target frame. `On click → Navigate to` unless noted.

| From frame | Hotspot to click | Goes to | Animation |
|---|---|---|---|
| 01 Sign in | **Sign in** button | 02 Two-factor setup | Dissolve 200 ms |
| 02 Two-factor setup | gold **Turn on…** button | 03 Overview | Dissolve 200 ms |
| 03 Overview | **Employees** card (or sidebar item) | 05 Employees | Instant |
| 03 Overview | **Sites** card (or sidebar item) | 07 Sites | Instant |
| 03 Overview | theme control (top right) | 04 Overview dark | Smart animate 300 ms |
| 04 Overview dark | theme control | 03 Overview | Smart animate 300 ms |
| 05 Employees | name **Kwame Kofi Mensah** | 06 Employee record | Dissolve 150 ms |
| 06 Employee record | **‹ Employees** back link | 05 Employees | Dissolve 150 ms |
| 05 / 06 / 07 | sidebar **Overview** | 03 Overview | Instant |
| 08 Mobile overview | **☰** menu button | 09 Mobile menu | Move in ← 250 ms |
| 09 Mobile menu | **✕** (or the dimmed area) | 08 Mobile overview | Move out → 250 ms |

Set the **flow starting point** on `01 Sign in` (right-hand panel → Flow
starting point); add a second flow starting on `08 Mobile overview` for the
phone story. Press **▶ Present** to click through it like the real app.

## Two useful extras

- **Pixel-perfect copies of the live app:** the free Figma plugin
  **html.to.design** imports any web page as editable Figma layers. Point it
  at https://samtec-test.vercel.app for screens this kit doesn't cover yet.
- **Regenerate or extend the kit:** every artboard is drawn by
  [generate.py](generate.py) (plain Python, no packages). Edit it, run
  `python generate.py` in this folder, and re-import the changed SVG.
