"""Generates the SAMTEC Figma kit: SVG artboards that import into Figma as
editable frames. Colours and layout mirror apps/web/src/index.css (the navy
and gold come from the favicon badge). Run:  python generate.py
"""

import os
import xml.etree.ElementTree as ET

OUT = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- palette ----
NAVY = "#13213a"        # brand navy (favicon)
SIDEBAR = "#1c2743"     # sidebar background
SIDEBAR_ACC = "#2a3757" # sidebar hover/active background
GOLD = "#e8b542"        # active marker / accents (favicon)
GOLD_INK = "#3a2c08"
BG = "#fafbfd"          # page background (light)
CARD = "#ffffff"
INK = "#1d2433"         # foreground
MUTED = "#66708a"       # muted text
FAINT = "#8a94ab"
BORDER = "#e2e6ee"
PRIMARY = "#223055"     # buttons
OK = "#16794c"
OK_BG = "#e9f7ef"
AMBER = "#8a5a06"
AMBER_BG = "#fdf3dd"
AMBER_BR = "#e8b54299"
RED = "#c03b30"
SLATE_BG = "#eef0f4"
SLATE = "#5b6474"
# dark mode
D_BG = "#14192b"
D_CARD = "#1d2438"
D_INK = "#f2f4f8"
D_MUTED = "#a6aec4"
D_BORDER = "#2c3450"

FONT = "Geist, Inter, 'Segoe UI', sans-serif"
MONO = "'JetBrains Mono', 'Geist Mono', monospace"

# ---------------------------------------------------------------- helpers ----
def T(x, y, s, size=14, fill=INK, weight=400, anchor="start", mono=False, spacing=None):
    fam = MONO if mono else FONT
    sp = f' letter-spacing="{spacing}"' if spacing else ""
    s = s.replace("&", "&amp;").replace("<", "&lt;")
    return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" '
            f'fill="{fill}" font-weight="{weight}" text-anchor="{anchor}"{sp}>{s}</text>')

def R(x, y, w, h, fill, rx=0, stroke=None, sw=1, opacity=None):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    op = f' opacity="{opacity}"' if opacity else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" rx="{rx}"{st}{op}/>'

def LINE(x1, y1, x2, y2, stroke=BORDER, sw=1):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"/>'

def G(id_, *parts, transform=None):
    tr = f' transform="{transform}"' if transform else ""
    return f'<g id="{id_}"{tr}>' + "".join(parts) + "</g>"

def ICON(name, x, y, color, scale=1.0):
    """A 20x20 stroke icon placed at (x, y)."""
    p = {
        "home": '<path d="M3 9.5 L10 3 L17 9.5 M5 8.5 V17 H8.5 V12.5 H11.5 V17 H15 V8.5"/>',
        "users": '<circle cx="8" cy="7" r="3"/><path d="M3 17 c0-4 10-4 10 0 M13.5 4.6 a3 3 0 0 1 0 4.8 M17 17 c0-2.6-1.6-3.6-3.2-3.9"/>',
        "pin": '<path d="M10 17.5 S4.5 12 4.5 8.2 A5.5 5.5 0 1 1 15.5 8.2 C15.5 12 10 17.5 10 17.5 Z"/><circle cx="10" cy="8.2" r="1.9"/>',
        "clock": '<circle cx="10" cy="10" r="7"/><path d="M10 6 V10 L13 12"/>',
        "wallet": '<rect x="3" y="6" width="14" height="10" rx="2"/><path d="M3 8.5 H17 M13 12 h2"/>',
        "shield": '<path d="M10 2.5 L16.5 5 V9.5 C16.5 14 13 16.3 10 17.5 C7 16.3 3.5 14 3.5 9.5 V5 Z"/>',
        "file": '<path d="M6 3 H12 L15 6 V17 H6 Z M12 3 V6 H15"/>',
        "activity": '<path d="M2.5 11 H6 L8.5 4.5 L12 15.5 L14 11 H17.5"/>',
        "arrow": '<path d="M4 10 H15 M11 5.5 L15.5 10 L11 14.5"/>',
        "menu": '<path d="M3.5 6 H16.5 M3.5 10 H16.5 M3.5 14 H16.5"/>',
        "logout": '<path d="M8.5 4 H4.5 V16 H8.5 M12 6.5 L15.5 10 L12 13.5 M15.5 10 H8"/>',
        "search": '<circle cx="9" cy="9" r="5"/><path d="M13 13 L16.5 16.5"/>',
        "monitor": '<rect x="3" y="4" width="14" height="9.5" rx="1.5"/><path d="M8 17 H12 M10 13.5 V17"/>',
        "chevL": '<path d="M12 5 L7 10 L12 15"/>',
        "chevR": '<path d="M8 5 L13 10 L8 15"/>',
        "check": '<circle cx="10" cy="10" r="7"/><path d="M6.8 10.2 L9 12.4 L13.4 7.8"/>',
        "x": '<circle cx="10" cy="10" r="7"/><path d="M7.5 7.5 L12.5 12.5 M12.5 7.5 L7.5 12.5"/>',
        "finger": '<path d="M5 8 a5 5 0 0 1 10 0 v3 M7.5 8 a2.5 2.5 0 0 1 5 0 v4 c0 2-1 3.5-2.5 4.5 M10 8 v4"/>',
        "moon": '<path d="M15.5 11.5 A6.2 6.2 0 1 1 8.5 4.5 A5 5 0 0 0 15.5 11.5 Z"/>',
        "refresh": '<path d="M16 6.5 A7 7 0 1 0 17 10 M16 3 V6.5 H12.5"/>',
        "back": '<path d="M12.5 4.5 L7 10 L12.5 15.5"/>',
    }[name]
    return (f'<g transform="translate({x},{y}) scale({scale})" fill="none" stroke="{color}" '
            f'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{p}</g>')

def logo(x, y, s=1.0):
    return (f'<g transform="translate({x},{y}) scale({s})">'
            f'<path fill="{NAVY}" d="M16 2 4 6.5v8.2c0 7.6 5.1 13.7 12 15.3 6.9-1.6 12-7.7 12-15.3V6.5L16 2Z"/>'
            f'<path fill="{GOLD}" d="m16 7.5-6.5 2.4v4.8c0 4.4 2.8 8 6.5 9.1 3.7-1.1 6.5-4.7 6.5-9.1V9.9L16 7.5Z"/></g>')

def badge(x, y, label, kind="ok"):
    w = len(label) * 6.4 + 18
    style = {"ok": (OK_BG, OK, "#16794c40"), "amber": (AMBER_BG, AMBER, AMBER_BR),
             "slate": (SLATE_BG, SLATE, "#5b647440"), "live": (SLATE_BG, INK, "#5b647400")}[kind]
    return G(f"badge-{label}",
             R(x, y, w, 20, style[0], rx=10, stroke=style[2]),
             T(x + w / 2, y + 14, label, size=11, fill=style[1], weight=600, anchor="middle"))

def button(x, y, w, label, kind="primary", icon=None):
    fills = {"primary": (PRIMARY, "#ffffff", None), "outline": (CARD, INK, BORDER),
             "gold": (GOLD, GOLD_INK, None), "ghost": ("none", MUTED, None)}
    bg, fg, br = fills[kind]
    parts = [R(x, y, w, 36, bg, rx=9, stroke=br)]
    tx = x + w / 2
    if icon:
        parts.append(ICON(icon, x + 12, y + 8, fg, 0.9))
        tx += 8
    parts.append(T(tx, y + 23, label, size=13.5, fill=fg, weight=600, anchor="middle"))
    return G(f"button-{label}", *parts)

def input_field(x, y, w, label, placeholder="", value=""):
    parts = [T(x, y + 12, label, size=13, fill=INK, weight=500),
             R(x, y + 20, w, 36, CARD, rx=8, stroke=BORDER)]
    if value:
        parts.append(T(x + 12, y + 43, value, size=13.5, fill=INK))
    elif placeholder:
        parts.append(T(x + 12, y + 43, placeholder, size=13.5, fill=FAINT))
    return G(f"field-{label}", *parts)

def select_field(x, y, w, label, value):
    return G(f"select-{label}",
             T(x, y + 12, label, size=13, fill=INK, weight=500),
             R(x, y + 20, w, 36, CARD, rx=8, stroke=BORDER),
             T(x + 12, y + 43, value, size=13.5, fill=INK),
             f'<path d="M{x + w - 20} {y + 34} l5 5 l5 -5" fill="none" stroke="{MUTED}" stroke-width="1.6" stroke-linecap="round"/>')

NAV = [("home", "Overview", None), ("users", "Employees", None), ("pin", "Sites", None),
       ("clock", "Attendance", "P2"), ("wallet", "Payroll", "P4"),
       ("shield", "Ghost detection", "P5"), ("file", "Reports", "P6"),
       ("activity", "System status", None)]

def sidebar(active="Overview", x=0, w=256, h=1024, user=("YB", "Yaw Boateng", "Supervisor")):
    parts = [R(x, 0, w, h, SIDEBAR), logo(x + 20, 16, 0.9),
             T(x + 56, 30, "SAMTEC", size=15, fill="#f2f4f8", weight=600, spacing="0.06em"),
             T(x + 56, 45, "Attendance & Payroll", size=10.5, fill="#aab3c9")]
    y = 78
    for icon, label, phase in NAV:
        if label == active:
            parts += [R(x + 12, y, w - 24, 38, SIDEBAR_ACC, rx=8),
                      R(x + 12, y, 3, 38, GOLD, rx=1.5)]
        color = "#f2f4f8" if label == active or not phase else "#8f99b3"
        parts.append(ICON(icon, x + 26, y + 9, color, 0.95))
        parts.append(T(x + 54, y + 24, label, size=13.5, fill=color,
                       weight=600 if label == active else 400))
        if phase:
            parts += [R(x + w - 46, y + 10, 26, 17, "none", rx=8.5, stroke="#3b4867"),
                      T(x + w - 33, y + 22, phase, size=9.5, fill="#8f99b3", weight=600, anchor="middle")]
        y += 42
    # user card
    uy = h - 66
    parts += [LINE(x, uy, x + w, uy, "#ffffff1f"),
              f'<circle cx="{x + 38}" cy="{uy + 33}" r="17" fill="{GOLD}"/>',
              T(x + 38, uy + 37.5, user[0], size=12, fill=GOLD_INK, weight=700, anchor="middle"),
              T(x + 64, uy + 29, user[1], size=13, fill="#f2f4f8", weight=600),
              T(x + 64, uy + 45, user[2], size=11, fill="#aab3c9"),
              ICON("logout", x + w - 34, uy + 23, "#aab3c9", 0.9)]
    return G("sidebar", *parts)

def topbar(w=1440, sx=256, mode="Live API", theme="System"):
    kind = "amber" if mode == "Mock data" else "live"
    return G("topbar",
             R(sx, 0, w - sx, 52, CARD), LINE(sx, 52, w, 52),
             badge(w - 240, 16, mode, kind),
             ICON("monitor", w - 132, 16, MUTED, 0.9),
             T(w - 106, 33, theme, size=13, fill=MUTED, weight=500))

def frame(name, w, h, *parts, bg=BG):
    body = "".join(parts)
    return (f'<svg id="{name}" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'xmlns="http://www.w3.org/2000/svg">{R(0, 0, w, h, bg)}{body}</svg>')

def card(x, y, w, h, *parts, dark=False):
    return G("card", R(x, y, w, h, D_CARD if dark else CARD, rx=14,
                       stroke=D_BORDER if dark else BORDER), *parts)

def qr(x, y, s=120):
    cell = s / 15
    rng = 2166136261
    parts = [R(x - 10, y - 10, s + 20, s + 20, "#ffffff", rx=10, stroke=BORDER)]
    for r in range(15):
        for c in range(15):
            rng = (rng * 16777619 + r * 31 + c * 7) % 2147483647
            if rng % 5 < 2:
                parts.append(R(x + c * cell, y + r * cell, cell - 1, cell - 1, NAVY))
    for (fx, fy) in [(0, 0), (10, 0), (0, 10)]:
        parts += [R(x + fx * cell, y + fy * cell, 5 * cell - 1, 5 * cell - 1, "none", stroke=NAVY, sw=2.5),
                  R(x + (fx + 1.5) * cell, y + (fy + 1.5) * cell, 2 * cell, 2 * cell, NAVY)]
    return G("qr-code", *parts)

# --------------------------------------------------------------- screens ----
def auth_left(h=1024):
    items = [("finger", "Every guard is enrolled once and proven unique."),
             ("pin", "Every shift is a biometric clock-in at a known site."),
             ("wallet", "Every pesewa paid traces back to a verified presence.")]
    parts = [R(0, 0, 620, h, SIDEBAR), logo(40, 36, 1.0),
             T(80, 52, "SAMTEC", size=17, fill="#f2f4f8", weight=600, spacing="0.06em"),
             T(40, h / 2 - 96, "From ghost payroll", size=34, fill="#f2f4f8", weight=700),
             T(40, h / 2 - 56, "to proven presence.", size=34, fill="#f2f4f8", weight=700)]
    y = h / 2
    for icon, txt in items:
        parts += [ICON(icon, 40, y - 14, GOLD), T(72, y, txt, size=14.5, fill="#c9d0e0")]
        y += 40
    parts.append(T(40, h - 40, "identity  →  presence  →  pay", size=12, fill="#8f99b3", mono=True))
    return G("brand-panel", *parts)

def screen_signin():
    cx = 620 + (820 - 360) / 2
    return frame("01 Sign in", 1440, 1024, auth_left(),
        card(cx, 330, 360, 330,
             logo(cx + 164, 352, 0.55),
             T(cx + 180, 396, "Sign in to SAMTEC", size=19, fill=INK, weight=700, anchor="middle"),
             T(cx + 180, 416, "Attendance & Payroll dashboard", size=12.5, fill=MUTED, anchor="middle"),
             input_field(cx + 28, 436, 304, "Email", value="samclerkson73@gmail.com"),
             input_field(cx + 28, 512, 304, "Password", value="••••••••••••••"),
             button(cx + 28, 596, 304, "Sign in")))

def screen_2fa():
    cx = 620 + (820 - 380) / 2
    steps = ["1.  Install an authenticator app on your phone.",
             "2.  Scan the code, or type the key into the app.",
             "3.  Enter the 6-digit code the app shows."]
    parts = [T(cx + 190, 220, "Set up two-factor authentication", size=18, fill=INK, weight=700, anchor="middle"),
             T(cx + 190, 240, "Your role requires a second step at every sign-in.", size=12.5, fill=MUTED, anchor="middle")]
    y = 268
    for s in steps:
        parts.append(T(cx + 28, y, s, size=13, fill=INK)); y += 22
    parts += [qr(cx + 120, 348),
              T(cx + 190, 512, "Cannot scan? Enter this key by hand:", size=11.5, fill=MUTED, anchor="middle"),
              T(cx + 190, 530, "AUXD FLHL VLZJ 6XGS", size=13, fill=INK, weight=600, anchor="middle", mono=True)]
    bx = cx + 65
    for i, d in enumerate("492039"):
        parts += [R(bx + i * 45, 550, 38, 46, CARD, rx=8, stroke=BORDER if i < 5 else PRIMARY, sw=1 if i < 5 else 2),
                  T(bx + i * 45 + 19, 580, d, size=20, fill=INK, weight=600, anchor="middle", mono=True)]
    parts.append(button(cx + 28, 620, 324, "Turn on two-factor authentication", kind="gold"))
    return frame("02 Two-factor setup", 1440, 1024, auth_left(),
                 card(cx, 190, 380, 500, *parts))

def open_card(x, y, w, icon, title, desc):
    return G(f"open-{title}",
             R(x, y, w, 128, CARD, rx=14, stroke=BORDER),
             R(x + 20, y + 20, 36, 36, "#22305514", rx=9),
             ICON(icon, x + 28, y + 28, PRIMARY),
             ICON("arrow", x + w - 40, y + 26, FAINT, 0.85),
             T(x + 20, y + 84, title, size=15.5, fill=INK, weight=700),
             T(x + 20, y + 106, desc, size=12.5, fill=MUTED))

def screen_overview(dark=False):
    bg = D_BG if dark else BG
    ink = D_INK if dark else INK
    muted = D_MUTED if dark else MUTED
    cw = (1440 - 256 - 64 - 48) / 3
    x0 = 256 + 32
    parts = [sidebar("Overview"), topbar(mode="Live API", theme="Dark" if dark else "System")]
    if dark:
        parts.insert(0, R(0, 0, 1440, 1024, D_BG))
        parts[2] = G("topbar", R(256, 0, 1184, 52, D_CARD), LINE(256, 52, 1440, 52, D_BORDER),
                     badge(1200, 16, "Live API", "live"), ICON("moon", 1308, 16, muted, 0.9),
                     T(1334, 33, "Dark", size=13, fill=muted, weight=500))
    parts += [T(x0, 118, "Good morning, Yaw", size=26, fill=ink, weight=700),
              T(x0, 142, "Monday, 21 September 2026  ·  signed in as Supervisor", size=13, fill=muted),
              T(x0, 190, "OPEN NOW", size=11.5, fill=muted, weight=600, spacing="0.12em")]
    cards = [("users", "Employees", "Guards and staff on the payroll."),
             ("pin", "Sites", "Client locations and who is on post."),
             ("activity", "System status", "Whether the API can reach its database.")]
    for i, (ic, t, d) in enumerate(cards):
        cx = x0 + i * (cw + 24)
        if dark:
            parts.append(G(f"open-{t}", R(cx, 206, cw, 128, D_CARD, rx=14, stroke=D_BORDER),
                           R(cx + 20, 226, 36, 36, "#e8b54222", rx=9), ICON(ic, cx + 28, 234, GOLD),
                           ICON("arrow", cx + cw - 40, 232, D_MUTED, 0.85),
                           T(cx + 20, 290, t, size=15.5, fill=D_INK, weight=700),
                           T(cx + 20, 312, d, size=12.5, fill=D_MUTED)))
        else:
            parts.append(open_card(cx, 206, cw, ic, t, d))
    rc, cc = (D_CARD, D_BORDER) if dark else (CARD, BORDER)
    y = 366
    parts += [
        G("card-role", R(x0, y, cw, 190, rc, rx=14, stroke=cc),
          T(x0 + 20, y + 32, "Your role", size=15, fill=ink, weight=700),
          T(x0 + 20, y + 52, "Supervisor", size=12.5, fill=muted),
          T(x0 + 20, y + 84, "Manages attendance and rosters for", size=13, fill=ink),
          T(x0 + 20, y + 104, "the sites they are posted to.", size=13, fill=ink)),
        G("card-system", R(x0 + cw + 24, y, cw, 190, rc, rx=14, stroke=cc),
          T(x0 + cw + 44, y + 32, "System", size=15, fill=ink, weight=700),
          T(x0 + cw + 44, y + 52, "Full status page", size=12.5, fill=muted),
          ICON("check", x0 + cw + 44, y + 72, "#2fae72" if dark else OK),
          T(x0 + cw + 72, y + 87, "API and database are up", size=13.5,
            fill="#2fae72" if dark else OK, weight=600)),
    ]
    later = [("clock", "Attendance", "Phase 2"), ("wallet", "Payroll", "Phase 4"),
             ("shield", "Ghost detection", "Phase 5"), ("file", "Reports", "Phase 6")]
    lp = [T(x0 + 2 * (cw + 24) + 20, y + 32, "Coming in later phases", size=15, fill=ink, weight=700)]
    ly = y + 58
    for ic, t, ph in later:
        lp += [ICON(ic, x0 + 2 * (cw + 24) + 20, ly - 13, muted, 0.85),
               T(x0 + 2 * (cw + 24) + 46, ly, t, size=13, fill=ink),
               R(x0 + 3 * cw + 2 * 24 - 66, ly - 13, 58, 18, "none", rx=9, stroke=cc),
               T(x0 + 3 * cw + 2 * 24 - 37, ly, ph, size=10, fill=muted, anchor="middle")]
        ly += 30
    parts.append(G("card-later", R(x0 + 2 * (cw + 24), y, cw, 190, rc, rx=14, stroke=cc), *lp))
    return frame("05 Overview dark" if dark else "03 Overview", 1440, 1024, *parts, bg=bg)

EMP_ROWS = [
    ("SMT-00001", "Kwame Kofi Mensah", "Security Guard", "Ridge Towers Office Complex", "Active", "Enrolled", "11 Mar 2024"),
    ("SMT-00002", "Abena Owusu", "Senior Guard", "Not posted", "Pending enrollment", "Not enrolled", "1 Sept 2026"),
    ("SMT-00003", "Yaw Boateng", "Site Supervisor", "Ridge Towers Office Complex", "Active", "Enrolled", "14 June 2021"),
    ("SMT-00004", "Akua Asante", "Security Guard", "East Legon Residences", "Active", "Enrolled", "2 Nov 2023"),
    ("SMT-00005", "Emmanuel Tetteh", "Patrol Officer", "Harbour Road Warehouse 7", "Active", "Enrolled", "21 Feb 2022"),
    ("SMT-00006", "Grace Adjei", "Security Guard", "Harbour Road Warehouse 7", "Suspended", "Enrolled", "30 July 2024"),
]

def table_card(x, y, w, headers, widths, rows, render_cell, dark=False):
    hh, rh = 44, 52
    h = hh + rh * len(rows)
    parts = [R(x, y, w, h, CARD, rx=14, stroke=BORDER),
             f'<path d="M{x} {y + 14} a14 14 0 0 1 14 -14 h{w - 28} a14 14 0 0 1 14 14 v{hh - 14} h-{w} Z" fill="#f1f3f8"/>']
    cx = x + 20
    for head, cw in zip(headers, widths):
        parts.append(T(cx, y + 28, head, size=12, fill=MUTED, weight=600))
        cx += cw
    ry = y + hh
    for i, row in enumerate(rows):
        if i:
            parts.append(LINE(x, ry, x + w, ry))
        cx = x + 20
        for j, cw in enumerate(widths):
            parts.append(render_cell(cx, ry, row, j))
            cx += cw
        ry += rh
    return G("table", *parts)

def screen_employees():
    x0, w = 256 + 32, 1440 - 256 - 64
    headers = ["Staff no.", "Name", "Position", "Site", "Status", "Biometrics", "Hired"]
    widths = [110, 190, 150, 250, 160, 120, 100]

    def cell(cx, ry, row, j):
        v = row[j]
        if j == 0:
            return T(cx, ry + 32, v, size=11.5, fill=MUTED, mono=True)
        if j == 1:
            return (T(cx, ry + 32, v, size=13.5, fill=PRIMARY, weight=600) +
                    LINE(cx, ry + 36, cx + len(v) * 6.6, ry + 36, PRIMARY, 1))
        if j == 4:
            kind = {"Active": "ok", "Pending enrollment": "amber", "Suspended": "amber",
                    "Terminated": "slate"}[v]
            return badge(cx, ry + 16, v, kind)
        fill = FAINT if v in ("Not posted", "Not enrolled") else INK
        return T(cx, ry + 32, v, size=13, fill=fill)

    return frame("06 Employees", 1440, 1024,
        sidebar("Employees"), topbar(),
        T(x0, 112, "Employees", size=24, fill=INK, weight=700),
        T(x0, 134, "Guards and staff on the company payroll.", size=13, fill=MUTED),
        input_field(x0, 158, 260, "Search employees", placeholder="Name or staff number"),
        button(x0 + 272, 178, 104, "Search", kind="outline", icon="search"),
        select_field(x0 + 400, 158, 180, "Status", "All statuses"),
        T(x0, 226, "Type at least 2 characters.", size=11, fill=FAINT),
        table_card(x0, 250, w, headers, widths, EMP_ROWS, cell),
        button(x0 + w - 216, 620, 104, "Previous", kind="outline", icon="chevL"),
        button(x0 + w - 100, 620, 100, "Next", kind="outline"))

def screen_record():
    x0 = 256 + 32
    cw = (1440 - 256 - 64 - 24) / 2

    def dl(x, y, rows):
        parts = []
        for i, (k, v, m) in enumerate(rows):
            yy = y + i * 34
            parts += [T(x, yy, k, size=13, fill=MUTED),
                      T(x + 130, yy, v, size=13, fill=INK, weight=500, mono=m)]
        return parts

    return frame("07 Employee record", 1440, 1024,
        sidebar("Employees"), topbar(),
        ICON("back", x0, 96, MUTED, 0.8), T(x0 + 22, 110, "Employees", size=13, fill=MUTED),
        f'<circle cx="{x0 + 30}" cy="166" r="28" fill="#22305514"/>',
        T(x0 + 30, 172, "KM", size=17, fill=PRIMARY, weight=700, anchor="middle"),
        T(x0 + 74, 160, "Kwame Kofi Mensah", size=23, fill=INK, weight=700),
        T(x0 + 74, 182, "SMT-00001  ·  Security Guard", size=12.5, fill=MUTED, mono=True),
        badge(1440 - 32 - 74, 150, "Active", "ok"),
        card(x0, 220, cw, 240,
             T(x0 + 24, 254, "Work", size=15.5, fill=INK, weight=700),
             *dl(x0 + 24, 292, [("Position", "Security Guard", False),
                                ("Current site", "Ridge Towers Office Complex", False),
                                ("Hired", "11 Mar 2024", False),
                                ("Biometrics", "Enrolled  12 Mar 2024, 10:00", False)])),
        card(x0 + cw + 24, 220, cw, 240,
             T(x0 + cw + 48, 254, "Contact and identity", size=15.5, fill=INK, weight=700),
             *dl(x0 + cw + 48, 292, [("Phone", "+233 20 000 0001", False),
                                     ("Email", "None", False),
                                     ("Ghana Card", "GHA-000000001-1", True)])),
        T(x0, 496, "Record created 11 Mar 2024, 09:00, last changed 10 Sept 2026, 12:00 (Ghana time).",
          size=11.5, fill=FAINT))

SITE_ROWS = [
    ("ACC-01", "Ridge Towers Office Complex", "Ridge Towers Management Ltd", "Accra, Greater Accra", "Active", "12"),
    ("ACC-02", "East Legon Residences", "Palmview Estates Ltd", "Accra, Greater Accra", "Active", "8"),
    ("CPC-01", "Pedu Junction Bank Branch", "Fanti Coast Savings Ltd", "Cape Coast, Central", "Inactive", "0"),
    ("KSI-01", "Adum Retail Centre", "Asante Retail Holdings", "Kumasi, Ashanti", "Active", "7"),
    ("TEM-01", "Harbour Road Warehouse 7", "Coastline Logistics Ltd", "Tema, Greater Accra", "Active", "5"),
    ("TKD-01", "Takoradi Port Depot", "Western Gateway Shipping Ltd", "Sekondi-Takoradi, Western", "Active", "4"),
]

def screen_sites():
    x0, w = 256 + 32, 1440 - 256 - 64
    headers = ["Code", "Name", "Client", "Location", "Status", "Guards on post"]
    widths = [90, 250, 250, 240, 130, 120]

    def cell(cx, ry, row, j):
        v = row[j]
        if j == 0:
            return T(cx, ry + 32, v, size=11.5, fill=MUTED, mono=True)
        if j == 1:
            return T(cx, ry + 32, v, size=13.5, fill=INK, weight=600)
        if j == 4:
            return badge(cx, ry + 16, v, "ok" if v == "Active" else "slate")
        if j == 5:
            return T(cx + 100, ry + 32, v, size=13, fill=INK, anchor="end", mono=True)
        return T(cx, ry + 32, v, size=13, fill=INK if j == 2 else MUTED)

    return frame("08 Sites", 1440, 1024,
        sidebar("Sites"), topbar(),
        T(x0, 112, "Sites", size=24, fill=INK, weight=700),
        T(x0, 134, "Client locations where guards are posted.", size=13, fill=MUTED),
        select_field(x0, 158, 180, "Status", "All statuses"),
        select_field(x0 + 204, 158, 200, "Region", "All regions"),
        table_card(x0, 236, w, headers, widths, SITE_ROWS, cell),
        button(x0 + w - 216, 606, 104, "Previous", kind="outline", icon="chevL"),
        button(x0 + w - 100, 606, 100, "Next", kind="outline"))

def mobile_top(title=True):
    parts = [R(0, 0, 390, 56, CARD), LINE(0, 56, 390, 56),
             R(14, 12, 34, 32, CARD, rx=8, stroke=BORDER), ICON("menu", 21, 18, INK, 0.9),
             logo(58, 14, 0.55), T(82, 34, "SAMTEC", size=14, fill=INK, weight=600, spacing="0.05em"),
             badge(255, 18, "Live API", "live"), ICON("monitor", 352, 18, MUTED, 0.85)]
    return G("mobile-topbar", *parts)

def screen_mobile():
    parts = [mobile_top(),
             T(20, 100, "Good morning, Yaw", size=21, fill=INK, weight=700),
             T(20, 122, "Monday, 21 September 2026", size=12, fill=MUTED),
             T(20, 160, "OPEN NOW", size=10.5, fill=MUTED, weight=600, spacing="0.12em")]
    cards = [("users", "Employees", "Guards and staff on the payroll."),
             ("pin", "Sites", "Client locations and who is on post."),
             ("activity", "System status", "Whether the API can reach its database.")]
    y = 176
    for ic, t, d in cards:
        parts.append(open_card(20, y, 350, ic, t, d))
        y += 144
    parts.append(G("card-role", R(20, y, 350, 110, CARD, rx=14, stroke=BORDER),
                   T(40, y + 30, "Your role", size=14.5, fill=INK, weight=700),
                   T(40, y + 50, "Supervisor", size=12, fill=MUTED),
                   T(40, y + 78, "Manages attendance and rosters for the", size=12.5, fill=INK),
                   T(40, y + 96, "sites they are posted to.", size=12.5, fill=INK)))
    return frame("09 Mobile overview", 390, 844, *parts)

def screen_mobile_menu():
    base = [mobile_top(), R(0, 0, 390, 844, "#0b101d", opacity="0.5")]
    panel = [R(0, 0, 300, 844, SIDEBAR), logo(18, 14, 0.8),
             T(50, 28, "SAMTEC", size=14, fill="#f2f4f8", weight=600, spacing="0.05em"),
             T(50, 43, "Attendance & Payroll", size=10, fill="#aab3c9"),
             f'<path d="M272 20 L284 32 M284 20 L272 32" stroke="#aab3c9" stroke-width="1.6" stroke-linecap="round"/>']
    y = 70
    for icon, label, phase in NAV:
        if label == "Overview":
            panel += [R(10, y, 280, 38, SIDEBAR_ACC, rx=8), R(10, y, 3, 38, GOLD, rx=1.5)]
        color = "#f2f4f8" if label == "Overview" or not phase else "#8f99b3"
        panel += [ICON(icon, 22, y + 9, color, 0.95),
                  T(50, y + 24, label, size=13.5, fill=color, weight=600 if label == "Overview" else 400)]
        if phase:
            panel += [R(250, y + 10, 26, 17, "none", rx=8.5, stroke="#3b4867"),
                      T(263, y + 22, phase, size=9.5, fill="#8f99b3", weight=600, anchor="middle")]
        y += 42
    panel += [LINE(0, 778, 300, 778, "#ffffff1f"),
              f'<circle cx="34" cy="811" r="17" fill="{GOLD}"/>',
              T(34, 815.5, "YB", size=12, fill=GOLD_INK, weight=700, anchor="middle"),
              T(60, 807, "Yaw Boateng", size=13, fill="#f2f4f8", weight=600),
              T(60, 823, "Supervisor", size=11, fill="#aab3c9"),
              ICON("logout", 262, 801, "#aab3c9", 0.9)]
    return frame("10 Mobile menu", 390, 844, *base, G("sheet-panel", *panel))

def screen_design_system():
    x0 = 48
    swatches = [("Navy (brand)", NAVY), ("Sidebar", SIDEBAR), ("Gold (accent)", GOLD),
                ("Primary", PRIMARY), ("Ink", INK), ("Muted", MUTED),
                ("Border", BORDER), ("Background", BG), ("OK", OK), ("Destructive", RED)]
    parts = [logo(x0, 40, 0.9), T(x0 + 38, 64, "SAMTEC design system", size=24, fill=INK, weight=700),
             T(x0, 104, "Colours are the CSS variables in apps/web/src/index.css. The navy and gold come from the favicon badge.",
               size=13, fill=MUTED),
             T(x0, 150, "COLOUR", size=11.5, fill=MUTED, weight=600, spacing="0.12em")]
    for i, (name, hexv) in enumerate(swatches):
        sx = x0 + (i % 5) * 268
        sy = 166 + (i // 5) * 110
        parts += [R(sx, sy, 244, 64, hexv, rx=10, stroke=BORDER),
                  T(sx, sy + 84, name, size=12.5, fill=INK, weight=600),
                  T(sx + 244, sy + 84, hexv, size=11.5, fill=MUTED, anchor="end", mono=True)]
    ty = 430
    parts += [T(x0, ty, "TYPE — Geist (fallback Inter) · JetBrains Mono for codes",
                size=11.5, fill=MUTED, weight=600, spacing="0.12em"),
              T(x0, ty + 44, "Page title / 24 Semibold", size=24, fill=INK, weight=700),
              T(x0, ty + 80, "Card title / 15.5 Semibold", size=15.5, fill=INK, weight=700),
              T(x0, ty + 110, "Body / 13.5 Regular — Guards and staff on the company payroll.", size=13.5, fill=INK),
              T(x0, ty + 138, "Muted / 12.5 — one quiet line under a heading.", size=12.5, fill=MUTED),
              T(x0, ty + 166, "Mono / 12 — SMT-00001 · GHA-000000001-1", size=12, fill=MUTED, mono=True),
              T(x0, ty + 216, "COMPONENTS", size=11.5, fill=MUTED, weight=600, spacing="0.12em"),
              button(x0, ty + 236, 130, "Primary"),
              button(x0 + 150, ty + 236, 130, "Outline", kind="outline"),
              button(x0 + 300, ty + 236, 200, "Gold action", kind="gold"),
              badge(x0 + 530, ty + 244, "Active", "ok"),
              badge(x0 + 610, ty + 244, "Pending enrollment", "amber"),
              badge(x0 + 760, ty + 244, "Inactive", "slate"),
              badge(x0 + 850, ty + 244, "Mock data", "amber"),
              input_field(x0, ty + 296, 280, "Input", placeholder="Placeholder text"),
              select_field(x0 + 310, ty + 296, 200, "Select", "All statuses"),
              T(x0, ty + 400, "Radii: cards 14 · controls 8–9 · pills 999.   Spacing grid: 4 / 8 / 12 / 20 / 24 / 32.   Sidebar 256, top bar 52.",
                size=12.5, fill=MUTED)]
    return frame("00 Design system", 1440, 900, *parts)

SCREENS = {
    "00-design-system.svg": screen_design_system,
    "01-sign-in.svg": screen_signin,
    "02-two-factor-setup.svg": screen_2fa,
    "03-overview.svg": lambda: screen_overview(False),
    "04-overview-dark.svg": lambda: screen_overview(True),
    "05-employees.svg": screen_employees,
    "06-employee-record.svg": screen_record,
    "07-sites.svg": screen_sites,
    "08-mobile-overview.svg": screen_mobile,
    "09-mobile-menu.svg": screen_mobile_menu,
}

if __name__ == "__main__":
    for name, fn in SCREENS.items():
        svg = fn()
        ET.fromstring(svg)  # refuse to write invalid XML
        with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(svg)
        print("wrote", name, f"({len(svg) // 1024} KB)")
