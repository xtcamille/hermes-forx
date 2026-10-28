"""High-resolution presentation visual generator with modern aesthetic themes.

Operates completely offline with zero external dependencies (uses PIL) as a robust,
deterministic fallback and visual synthesis engine when external image generation
providers (e.g. Fal, OpenAI DALL-E) are not configured or network is unavailable.
"""
from __future__ import annotations

import io
import math
import random
import re
from PIL import Image, ImageDraw, ImageFont


def _get_font(size: int, bold: bool = False):
    """Attempt to load a clean system font or fall back to PIL default."""
    font_names = (
        ["msyh.ttc", "simhei.ttf", "arial.ttf", "segoeui.ttf"]
        if not bold
        else ["msyhbd.ttc", "simheibd.ttf", "arialbd.ttf", "segoeuib.ttf"]
    )
    for name in font_names:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    clean = hex_str.lstrip("#")
    if len(clean) == 3:
        clean = "".join(c * 2 for c in clean)
    return int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)


def _lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    factor = max(0.0, min(1.0, factor))
    return (
        int(c1[0] + (c2[0] - c1[0]) * factor),
        int(c1[1] + (c2[1] - c1[1]) * factor),
        int(c1[2] + (c2[2] - c1[2]) * factor),
    )


def create_presentation_visual(
    prompt: str,
    aspect_ratio: str = "landscape",
    style: str = "illustration",
) -> bytes:
    """Generate an enterprise-grade presentation graphic returned as raw PNG bytes."""
    clean_prompt = (prompt or "商务技术架构方案").strip()

    # Dimension resolution
    if aspect_ratio == "square":
        width, height = 1024, 1024
    elif aspect_ratio == "portrait":
        width, height = 720, 1080
    else:  # landscape default (16:9)
        width, height = 1280, 720

    img = Image.new("RGBA", (width, height), (0, 0, 0, 255))
    draw = ImageDraw.Draw(img)

    # Theme palette definition
    style_key = style.lower() if isinstance(style, str) else "illustration"
    if style_key == "tech":
        bg_top = _hex_to_rgb("#070B19")
        bg_bot = _hex_to_rgb("#121B3A")
        primary = _hex_to_rgb("#00D2FF")
        accent = _hex_to_rgb("#3A7BD5")
        glow = _hex_to_rgb("#00F2FE")
        card_fill = (18, 28, 58, 210)
        card_stroke = (0, 210, 255, 90)
        text_primary = "#FFFFFF"
        text_accent = "#00D2FF"
        badge_label = "TECH ARCHITECTURE"
    elif style_key == "3d":
        bg_top = _hex_to_rgb("#18181B")
        bg_bot = _hex_to_rgb("#27272A")
        primary = _hex_to_rgb("#6366F1")
        accent = _hex_to_rgb("#EC4899")
        glow = _hex_to_rgb("#A855F7")
        card_fill = (39, 39, 42, 220)
        card_stroke = (168, 85, 247, 100)
        text_primary = "#FFFFFF"
        text_accent = "#A855F7"
        badge_label = "3D PERSPECTIVE"
    elif style_key == "photo":
        bg_top = _hex_to_rgb("#0F172A")
        bg_bot = _hex_to_rgb("#1E293B")
        primary = _hex_to_rgb("#38BDF8")
        accent = _hex_to_rgb("#0284C7")
        glow = _hex_to_rgb("#7DD3FC")
        card_fill = (30, 41, 59, 210)
        card_stroke = (56, 189, 248, 80)
        text_primary = "#F8FAFC"
        text_accent = "#38BDF8"
        badge_label = "BUSINESS OVERVIEW"
    else:  # illustration / business default
        bg_top = _hex_to_rgb("#0B132B")
        bg_bot = _hex_to_rgb("#1C2541")
        primary = _hex_to_rgb("#0077ED")
        accent = _hex_to_rgb("#00C49F")
        glow = _hex_to_rgb("#5BC0BE")
        card_fill = (28, 37, 65, 210)
        card_stroke = (91, 192, 190, 80)
        text_primary = "#FFFFFF"
        text_accent = "#5BC0BE"
        badge_label = "ENTERPRISE ILLUSTRATION"

    # 1. Background vertical gradient
    for y in range(height):
        factor = y / float(height)
        color = _lerp_color(bg_top, bg_bot, factor)
        draw.line([(0, y), (width, y)], fill=color)

    # 2. Geometric ambient glow & background grid
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ov_draw = ImageDraw.Draw(overlay)

    # Decorative background grid lines
    grid_gap = 64
    for gx in range(0, width, grid_gap):
        ov_draw.line([(gx, 0), (gx, height)], fill=(255, 255, 255, 6))
    for gy in range(0, height, grid_gap):
        ov_draw.line([(0, gy), (width, gy)], fill=(255, 255, 255, 6))

    # Concentric ambient glow rings in center
    cx, cy = int(width * 0.5), int(height * 0.46)
    for r in range(min(width, height) // 2, 40, -35):
        alpha = int(18 * (1.0 - (r / (min(width, height) / 2))))
        ov_draw.ellipse(
            [(cx - r, cy - r), (cx + r, cy + r)],
            fill=(glow[0], glow[1], glow[2], alpha),
        )

    # 3. Layered glassmorphic presentation cards
    # Outer background card
    card_w, card_h = int(width * 0.72), int(height * 0.62)
    card_x1, card_y1 = (width - card_w) // 2, (height - card_h) // 2 - 10
    card_x2, card_y2 = card_x1 + card_w, card_y1 + card_h
    ov_draw.rounded_rectangle(
        [(card_x1, card_y1), (card_x2, card_y2)],
        radius=24,
        fill=card_fill,
        outline=card_stroke,
        width=2,
    )

    # Inner decorative isometric / geometric shapes
    # Left floating accent card
    ac_w, ac_h = int(card_w * 0.28), int(card_h * 0.58)
    ac_x1, ac_y1 = card_x1 + 36, card_y1 + 40
    ov_draw.rounded_rectangle(
        [(ac_x1, ac_y1), (ac_x1 + ac_w, ac_y1 + ac_h)],
        radius=16,
        fill=(primary[0], primary[1], primary[2], 40),
        outline=(primary[0], primary[1], primary[2], 120),
        width=2,
    )
    # Right floating accent card
    rc_w, rc_h = int(card_w * 0.28), int(card_h * 0.58)
    rc_x1, rc_y1 = card_x2 - rc_w - 36, card_y1 + 40
    ov_draw.rounded_rectangle(
        [(rc_x1, rc_y1), (rc_x1 + rc_w, rc_y1 + rc_h)],
        radius=16,
        fill=(accent[0], accent[1], accent[2], 40),
        outline=(accent[0], accent[1], accent[2], 120),
        width=2,
    )

    # Center hero motif: Modern interconnected nodes & data visual curves
    center_w = card_w - (ac_w + rc_w + 110)
    center_x1 = ac_x1 + ac_w + 20
    center_cx = center_x1 + center_w // 2
    center_cy = card_y1 + card_h // 2 - 15

    # Glowing connecting curves
    curve_points = [
        (ac_x1 + ac_w // 2, ac_y1 + ac_h // 2),
        (center_cx - 45, center_cy - 30),
        (center_cx, center_cy + 25),
        (center_cx + 45, center_cy - 30),
        (rc_x1 + rc_w // 2, rc_y1 + rc_h // 2),
    ]
    for idx in range(len(curve_points) - 1):
        p1, p2 = curve_points[idx], curve_points[idx + 1]
        ov_draw.line([p1, p2], fill=(glow[0], glow[1], glow[2], 180), width=3)

    # Center floating sphere/hex
    for r in range(48, 12, -6):
        ov_draw.ellipse(
            [(center_cx - r, center_cy - r), (center_cx + r, center_cy + r)],
            fill=(primary[0], primary[1], primary[2], 30),
            outline=(glow[0], glow[1], glow[2], 160),
            width=2,
        )
    ov_draw.ellipse(
        [(center_cx - 16, center_cy - 16), (center_cx + 16, center_cy + 16)],
        fill=(255, 255, 255, 230),
    )

    # Node indicators on side cards
    for ny in (ac_y1 + 40, ac_y1 + 90, ac_y1 + 140):
        if ny < ac_y1 + ac_h - 20:
            ov_draw.rounded_rectangle(
                [(ac_x1 + 16, ny), (ac_x1 + ac_w - 16, ny + 12)],
                radius=4,
                fill=(primary[0], primary[1], primary[2], 120),
            )
    for ny in (rc_y1 + 40, rc_y1 + 90, rc_y1 + 140):
        if ny < rc_y1 + rc_h - 20:
            ov_draw.rounded_rectangle(
                [(rc_x1 + 16, ny), (rc_x1 + rc_w - 16, ny + 12)],
                radius=4,
                fill=(accent[0], accent[1], accent[2], 120),
            )

    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    # 4. Typography & Topic Labels
    # Top Tag Badge
    font_badge = _get_font(13, bold=True)
    badge_text = f"✦ {badge_label} · FORX"
    bw = len(badge_text) * 8 + 24
    bx1 = (width - bw) // 2
    by1 = card_y1 - 38
    draw.rounded_rectangle(
        [(bx1, by1), (bx1 + bw, by1 + 28)],
        radius=14,
        fill=(primary[0], primary[1], primary[2], 80),
        outline=(primary[0], primary[1], primary[2], 180),
        width=1,
    )
    draw.text(
        (bx1 + 12, by1 + 6),
        badge_text,
        fill=text_accent,
        font=font_badge,
    )

    # Title Banner at bottom of card
    font_title = _get_font(22, bold=True)
    display_title = clean_prompt[:32] + ("…" if len(clean_prompt) > 32 else "")
    # Center text
    try:
        bbox = draw.textbbox((0, 0), display_title, font=font_title)
        tw = bbox[2] - bbox[0]
    except Exception:
        tw = len(display_title) * 16
    tx = (width - tw) // 2
    ty = card_y2 - 62
    draw.text((tx, ty), display_title, fill=text_primary, font=font_title)

    # Subtitle note
    font_sub = _get_font(12, bold=False)
    sub_text = "Presentation Concept Visual · High Resolution Vector Composition"
    try:
        sbox = draw.textbbox((0, 0), sub_text, font=font_sub)
        sw = sbox[2] - sbox[0]
    except Exception:
        sw = len(sub_text) * 7
    draw.text(((width - sw) // 2, card_y2 - 32), sub_text, fill="#94A3B8", font=font_sub)

    # Convert to PNG stream
    final_rgb = img.convert("RGBA")
    stream = io.BytesIO()
    final_rgb.save(stream, format="PNG")
    return stream.getvalue()
