#!/usr/bin/env python3
"""Generate premium Prpl CRM app icon — v2 clean."""

from PIL import Image, ImageDraw, ImageFilter
import math

SIZE = 1024
# We'll render at 2x and downscale for anti-aliasing
RENDER = SIZE * 2
RADIUS = 440  # at 2x

def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(len(c1)))

def draw_thick_arc(draw, cx, cy, rx, ry, start_deg, end_deg, width, fill):
    """Draw a thick arc using pieslice difference."""
    outer_box = [cx - rx, cy - ry, cx + rx, cy + ry]
    inner_rx, inner_ry = rx - width, ry - width
    inner_box = [cx - inner_rx, cy - inner_ry, cx + inner_rx, cy + inner_ry]

    # Draw outer arc
    draw.arc(outer_box, start_deg, end_deg, fill=fill, width=width)

def create_icon():
    S = RENDER
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # === Background gradient (diagonal purple) ===
    bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    colors_top = (67, 56, 202)      # indigo-700
    colors_mid = (99, 102, 241)     # indigo-500
    colors_bot = (139, 92, 246)     # violet-500
    colors_corner = (109, 40, 217)  # violet-700

    for y in range(S):
        for x in range(S):
            # Diagonal gradient
            t = (x / S * 0.4 + y / S * 0.6)
            if t < 0.5:
                c = lerp_color(colors_top, colors_mid, t / 0.5)
            else:
                c = lerp_color(colors_mid, colors_bot, (t - 0.5) / 0.5)
            bg.putpixel((x, y), c + (255,))

    # Rounded rect mask
    mask = Image.new('L', (S, S), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([(0, 0), (S-1, S-1)], radius=RADIUS, fill=255)

    img.paste(bg, mask=mask)

    # === Soft top-left light ===
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    gcx, gcy = int(S * 0.3), int(S * 0.15)
    for r in range(int(S * 0.5), 0, -2):
        alpha = int(25 * (1 - r / (S * 0.5)) ** 1.5)
        glow_draw.ellipse([gcx - r, gcy - r, gcx + r, gcy + r],
                          fill=(255, 255, 255, alpha))
    img = Image.alpha_composite(img, glow)

    draw = ImageDraw.Draw(img)
    cx, cy = S // 2, S // 2

    # === Outer orbit ring (subtle dotted) ===
    ring_r = 620
    for angle in range(0, 360, 4):
        # Make segments appear/disappear
        segment = angle % 60
        if segment < 40:  # visible segments
            opacity = int(60 * (1 - abs(segment - 20) / 20))
            rad = math.radians(angle)
            px = cx + ring_r * math.cos(rad)
            py = cy + ring_r * math.sin(rad)
            dot_r = 4
            draw.ellipse([px - dot_r, py - dot_r, px + dot_r, py + dot_r],
                        fill=(255, 255, 255, opacity))

    # === Connection nodes ===
    node_angles = [45, 135, 225, 315, 0]
    node_sizes = [20, 16, 18, 14, 12]
    for angle, ns in zip(node_angles, node_sizes):
        rad = math.radians(angle)
        nx = cx + ring_r * math.cos(rad)
        ny = cy + ring_r * math.sin(rad)
        # Glow
        draw.ellipse([nx - ns*2, ny - ns*2, nx + ns*2, ny + ns*2],
                     fill=(255, 255, 255, 25))
        # Outer
        draw.ellipse([nx - ns, ny - ns, nx + ns, ny + ns],
                     fill=(255, 255, 255, 80))
        # Inner bright
        draw.ellipse([nx - ns//2, ny - ns//2, nx + ns//2, ny + ns//2],
                     fill=(255, 255, 255, 180))

    # === Central monogram "P" — clean geometric ===

    # P stem — thick rounded bar
    stem_w = 100
    stem_x = cx - 120
    stem_top = cy - 340
    stem_bot = cy + 340
    draw.rounded_rectangle(
        [stem_x, stem_top, stem_x + stem_w, stem_bot],
        radius=stem_w // 2,
        fill=(255, 255, 255, 245)
    )

    # P bowl — thick arc using ellipse outlines
    bowl_cx = stem_x + stem_w - 10
    bowl_cy = stem_top + 280
    bowl_w = 340
    bowl_h = 300
    arc_thickness = 95

    # Draw P bowl as thick arc (right half of ellipse)
    # Outer ellipse
    outer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    outer_draw = ImageDraw.Draw(outer)
    outer_draw.ellipse(
        [bowl_cx - bowl_w, bowl_cy - bowl_h,
         bowl_cx + bowl_w, bowl_cy + bowl_h],
        fill=(255, 255, 255, 245)
    )

    # Cut inner ellipse
    iw = bowl_w - arc_thickness
    ih = bowl_h - arc_thickness
    outer_draw.ellipse(
        [bowl_cx - iw, bowl_cy - ih,
         bowl_cx + iw, bowl_cy + ih],
        fill=(0, 0, 0, 0)
    )

    # Keep only right half
    outer_draw.rectangle([0, 0, bowl_cx, S], fill=(0, 0, 0, 0))

    # Keep only the part from stem_top to bowl bottom
    outer_draw.rectangle([0, 0, S, bowl_cy - bowl_h - 10], fill=(0, 0, 0, 0))
    outer_draw.rectangle([0, bowl_cy + bowl_h + 10, S, S], fill=(0, 0, 0, 0))

    img = Image.alpha_composite(img, outer)
    draw = ImageDraw.Draw(img)

    # === Three data lines (CRM/list symbol) ===
    lines_x = cx + 80
    lines_y = cy + 100
    line_specs = [(200, 12, 160), (160, 12, 120), (110, 12, 80)]
    for i, (length, height, opacity) in enumerate(line_specs):
        y = lines_y + i * 50
        draw.rounded_rectangle(
            [lines_x, y, lines_x + length, y + height],
            radius=height // 2,
            fill=(255, 255, 255, opacity)
        )

    # === Sparkle accents ===
    def draw_sparkle(x, y, size, alpha):
        pts = [
            (x, y - size),
            (x + size * 0.35, y),
            (x, y + size),
            (x - size * 0.35, y),
        ]
        draw.polygon(pts, fill=(255, 255, 255, alpha))

    draw_sparkle(S * 0.82, S * 0.18, 36, 200)
    draw_sparkle(S * 0.88, S * 0.26, 20, 130)
    draw_sparkle(S * 0.20, S * 0.82, 24, 100)

    # === Subtle bottom vignette ===
    vig = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    vig_draw = ImageDraw.Draw(vig)
    for y in range(int(S * 0.8), S):
        t = (y - S * 0.8) / (S * 0.2)
        alpha = int(30 * t * t)
        vig_draw.rectangle([0, y, S, y + 1], fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img, vig)

    # === Downscale for anti-aliasing ===
    img = img.resize((SIZE, SIZE), Image.LANCZOS)

    return img


if __name__ == '__main__':
    import os
    icon = create_icon()

    base = os.path.dirname(os.path.abspath(__file__))

    # Save 1024x1024 for iOS App Icon
    out_1024 = os.path.join(base, 'PrplCRM/Assets.xcassets/AppIcon.appiconset/icon-1024.png')
    icon.save(out_1024, 'PNG')
    print(f'Saved: {out_1024}')

    # Save logo for splash screen
    logo = icon.resize((512, 512), Image.LANCZOS)
    out_logo = os.path.join(base, 'PrplCRM/Assets.xcassets/AppLogo.imageset/logo.png')
    logo.save(out_logo, 'PNG')
    print(f'Saved: {out_logo}')

    # Also generate PWA icons
    pwa_dir = os.path.join(base, '..', 'client', 'public', 'icons')
    sizes = [72, 96, 128, 144, 152, 192, 384, 512]
    for s in sizes:
        resized = icon.resize((s, s), Image.LANCZOS)
        out = os.path.join(pwa_dir, f'icon-{s}x{s}.png')
        resized.save(out, 'PNG')
        print(f'Saved: {out}')

    # Apple touch icon
    touch = icon.resize((180, 180), Image.LANCZOS)
    touch_path = os.path.join(pwa_dir, '..', 'apple-touch-icon.png')
    touch.save(touch_path, 'PNG')
    print(f'Saved: {touch_path}')

    print('\nDone!')
