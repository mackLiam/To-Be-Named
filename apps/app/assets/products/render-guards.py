import subprocess, pathlib

OUT = pathlib.Path(__file__).parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

NAVY_900, NAVY_700, ORANGE, WHITE = "#0B1B2B", "#14314B", "#F4600B", "#FFFFFF"

# Shell outline: wide at the knee, tapering to a rounded ankle end. Kept in one
# place because the clip path, the highlight and the contour lines all reuse it.
SHELL = ("M -75 -170 C -75 -196 -55 -208 -30 -209 L 30 -209 C 55 -208 75 -196 75 -170 "
         "C 80 -60 70 60 52 140 C 46 172 26 192 0 192 C -26 192 -46 172 -52 140 "
         "C -70 60 -80 -60 -75 -170 Z")


def guard(x, y, scale, gid, accent, rot=0, stretch=1.0):
    # Contour lines sit at the S1-S4 slice planes (20/40/60/80% of leg length,
    # measured up from the ankle) - the render is the schema, not decoration.
    slices = "".join(
        f'<path d="M -110 {yy} C -50 {yy - 16} 50 {yy - 16} 110 {yy}"/>'
        for yy in (146, 62, -22, -106)
    )
    vents = "".join(
        f'<rect x="{vx}" y="{vy}" width="22" height="7" rx="3.5"/>'
        for vy in (-160, -138, -116, -94)
        for vx in (-36, 12)
    )
    return f"""
  <g transform="translate({x},{y}) rotate({rot}) scale({scale},{scale * stretch})">
    <ellipse cx="0" cy="-10" rx="150" ry="240" fill="url(#glow)"/>
    <ellipse cx="6" cy="206" rx="82" ry="13" fill="#000" opacity="0.4"/>
    <clipPath id="clip{gid}"><path d="{SHELL}"/></clipPath>
    <path d="{SHELL}" fill="url(#shell{gid})"/>
    <g clip-path="url(#clip{gid})">
      <path d="M -75 -209 L -6 -209 C -18 -60 -20 60 -6 192 L -75 192 Z" fill="{WHITE}" opacity="0.10"/>
      <path d="M 46 -209 L 75 -209 L 75 192 L 34 192 C 50 60 52 -60 46 -209 Z" fill="{NAVY_900}" opacity="0.12"/>
      <g stroke="{accent}" stroke-width="3" fill="none" opacity="0.9">{slices}</g>
      <g fill="{NAVY_900}" opacity="0.35">{vents}</g>
      <path d="M -110 108 C -50 92 50 92 110 108 L 110 140 C 50 124 -50 124 -110 140 Z"
            fill="{NAVY_900}" opacity="0.85"/>
      <path d="M -96 -209 L -34 -209 L 30 192 L -30 192 Z" fill="{WHITE}" opacity="0.16"/>
    </g>
    <path d="{SHELL}" fill="none" stroke="{WHITE}" stroke-opacity="0.22" stroke-width="2"/>
  </g>"""


def page(body, gradients):
    grads = "".join(f"""
      <linearGradient id="shell{gid}" x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="{a}"/><stop offset="0.5" stop-color="{b}"/>
        <stop offset="1" stop-color="{c}"/>
      </linearGradient>""" for gid, a, b, c in gradients)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{{margin:0;padding:0;background:{NAVY_900}}} svg{{display:block}}
    </style></head><body>
    <svg width="1200" height="675" viewBox="0 0 1200 675" xmlns="http://www.w3.org/2000/svg">
      <defs>{grads}
        <radialGradient id="bg" cx="0.5" cy="0.32" r="0.8">
          <stop offset="0" stop-color="{NAVY_700}"/><stop offset="1" stop-color="{NAVY_900}"/>
        </radialGradient>
        <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#F4600B" stop-opacity="0.32"/>
          <stop offset="1" stop-color="#F4600B" stop-opacity="0"/>
        </radialGradient>
        <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M 48 0 L 0 0 0 48" fill="none" stroke="{WHITE}" stroke-opacity="0.05"/>
        </pattern>
      </defs>
      <rect width="1200" height="675" fill="url(#bg)"/>
      <rect width="1200" height="675" fill="url(#grid)"/>
      {body}
    </svg></body></html>"""


LIGHT = ("#FDFEFF", "#DDE4EA", "#AFBBC6")
FIRE = ("#FF8A3D", "#F4600B", "#A83C06")

VARIANTS = {
    "guard-single": ([guard(600, 336, 1.38, "a", ORANGE, rot=-6)],
                     [("a",) + LIGHT]),
    "guard-pair": ([guard(408, 336, 1.22, "a", ORANGE, rot=-10),
                    guard(792, 336, 1.22, "b", ORANGE, rot=10)],
                   [("a",) + LIGHT, ("b",) + LIGHT]),
    "guard-keeper": ([guard(600, 336, 1.3, "a", WHITE, rot=-6, stretch=1.12)],
                     [("a",) + FIRE]),
}

for name, (gs, defs) in VARIANTS.items():
    html = OUT / f"{name}.html"
    html.write_text(page("".join(gs), defs))
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    f"--screenshot={OUT / (name + '.png')}", "--window-size=1200,675",
                    f"file://{html}"], capture_output=True)
    print(name, (OUT / f"{name}.png").stat().st_size)
