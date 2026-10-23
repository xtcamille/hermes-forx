"""SVG scene preview with explicit hit targets; no user-provided markup is executed."""
from __future__ import annotations

import math
from html import escape

from .models import display_width, effective, resolved_color


def _wrap(text, capacity):
    lines = []
    for paragraph in text.split("\n"):
        current = ""
        for char in paragraph:
            if current and display_width(current + char) > capacity:
                lines.append(current)
                current = ""
            current += char
        lines.append(current)
    return lines


def _text(e, box, style, deck):
    size = style["font_size"]
    x, y, width, height = (v * 72 for v in (box.x, box.y, box.width, box.height))
    anchor = {"left": "start", "center": "middle", "right": "end"}[style["align"]]
    tx = {"left": x + 5, "center": x + width / 2, "right": x + width - 5}[style["align"]]
    lines = _wrap(e.text, max(1, (width - 10) / size))
    spans = "".join(f'<tspan x="{tx}" y="{y + 3 + size + i * size * 1.2}">{escape(line)}</tspan>' for i, line in enumerate(lines))
    fill = resolved_color(style["fill"], deck)
    background = f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="{fill}"/>' if fill != "none" else ""
    return (background + f'<clipPath id="clip-{e.id}"><rect x="{x}" y="{y}" width="{width}" height="{height}"/></clipPath>'
            f'<text clip-path="url(#clip-{e.id})" text-anchor="{anchor}" font-family="{escape(style["font_family"], quote=True)}" '
            f'font-size="{size}" font-weight="{700 if style["bold"] else 400}" fill="{resolved_color(style["color"], deck)}">{spans}</text>')


def _shape(e, box, style, deck):
    x, y, w, h = (v * 72 for v in (box.x, box.y, box.width, box.height))
    kind = e.shape or deck.theme["shape"]
    fill = style["fill"] if e.style.fill is not None else "$surface"
    paint = f'fill="{resolved_color(fill, deck)}" stroke="{resolved_color(style["line"], deck)}" stroke-width="{style["line_width"]}"'
    tags = {
        "rect": lambda: f'<rect x="{x}" y="{y}" width="{w}" height="{h}" {paint}/>',
        "roundRect": lambda: f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" {paint}/>',
        "ellipse": lambda: f'<ellipse cx="{x+w/2}" cy="{y+h/2}" rx="{w/2}" ry="{h/2}" {paint}/>',
        "line": lambda: f'<line x1="{x}" y1="{y}" x2="{x+w}" y2="{y+h}" stroke="{resolved_color(style["line"] if style["line"] != "none" else "$primary", deck)}" stroke-width="{style["line_width"]}"/>',
    }
    return tags[kind]()


def _image(e, box, style, deck):
    x, y, w, h = (v * 72 for v in (box.x, box.y, box.width, box.height))
    left, top, right, bottom = e.crop
    # Cropping is expressed in the original image's normalized viewport.
    return (f'<svg x="{x}" y="{y}" width="{w}" height="{h}" viewBox="{left} {top} {1-left-right} {1-top-bottom}" preserveAspectRatio="none">'
            f'<image href="forx-asset:{e.asset_id}" width="1" height="1" preserveAspectRatio="none"/></svg>')


def _table(e, box, style, deck):
    x, y, w, h = (v * 72 for v in (box.x, box.y, box.width, box.height))
    weights = e.column_widths or [1] * len(e.rows[0])
    widths = [w * v / sum(weights) for v in weights]
    starts = [sum(widths[:i]) for i in range(len(widths))]
    rh = h / len(e.rows)
    chunks = []
    for r, row in enumerate(e.rows):
        for c, text in enumerate(row):
            rw, cx = widths[c], x + starts[c]
            fill, fg = ("$primary", "$background") if r == 0 else ("$surface", style["color"])
            chunks.append(f'<rect x="{cx}" y="{y+r*rh}" width="{rw}" height="{rh}" fill="{resolved_color(fill, deck)}" stroke="{deck.theme["background"]}"/>')
            clip_id = f"{e.id}-{r}-{c}"
            chunks.append(f'<clipPath id="{clip_id}"><rect x="{cx}" y="{y+r*rh}" width="{rw}" height="{rh}"/></clipPath>')
            for line, value in enumerate(_wrap(text, max(1, (rw - 10) / style["font_size"]))):
                chunks.append(f'<text clip-path="url(#{clip_id})" x="{cx+5}" y="{y+r*rh+style["font_size"]*(1.1+1.2*line)}" '
                              f'font-size="{style["font_size"]}" font-weight="{700 if (e.style.bold if e.style.bold is not None else r == 0) else 400}" fill="{resolved_color(fg, deck)}" font-family="{escape(style["font_family"], quote=True)}">{escape(value)}</text>')
    return "".join(chunks)


def _chart(e, box, style, deck):
    x, y, w, h = (v * 72 for v in (box.x, box.y, box.width, box.height))
    palette = [deck.theme[key] for key in ("primary", "accent", "muted", "surface")]
    chunks = []
    if e.text:
        chunks.append(f'<text x="{x+10}" y="{y+style["font_size"]}" fill="{resolved_color(style["color"], deck)}" font-family="{escape(style["font_family"], quote=True)}" font-size="{style["font_size"]}">{escape(e.text)}</text>')
    if e.chart_type == "pie":
        values = e.series[0].values
        total, angle = sum(values), -math.pi / 2
        radius = min(w, h) * 0.35
        cx, cy = x + w / 2, y + h / 2
        for i, value in enumerate(values):
            arc = value / total * 2 * math.pi
            if arc >= math.tau - 1e-8:
                chunks.append(f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="{palette[i%4]}"/>')
            elif arc > 0:
                end = angle + arc
                path = f'M {cx} {cy} L {cx+radius*math.cos(angle)} {cy+radius*math.sin(angle)} A {radius} {radius} 0 {int(arc>math.pi)} 1 {cx+radius*math.cos(end)} {cy+radius*math.sin(end)} Z'
                chunks.append(f'<path d="{path}" fill="{palette[i%4]}"/>')
            angle += arc
    else:
        values = [v for s in e.series for v in s.values]
        low, high = min(0, min(values)), max(0, max(values))
        span = high - low or 1
        plot_h, plot_w = max(1, h - 60), max(1, w - 50)
        zero = y + 30 + high / span * plot_h
        chunks.append(f'<line x1="{x+30}" y1="{zero}" x2="{x+w-10}" y2="{zero}" stroke="{deck.theme["muted"]}"/>')
        for s, series in enumerate(e.series):
            points = []
            for i, value in enumerate(series.values):
                px = x + 30 + (i + 0.5) * plot_w / len(e.categories)
                py = y + 30 + (high - value) / span * plot_h
                points.append(f"{px},{py}")
                if e.chart_type == "column":
                    bw = plot_w / len(e.categories) / (len(e.series) + 1)
                    bx = px + (s - len(e.series) / 2) * bw
                    chunks.append(f'<rect x="{bx}" y="{min(py,zero)}" width="{bw*.9}" height="{max(.2,abs(zero-py))}" fill="{palette[s%3]}"/>')
            if e.chart_type == "line":
                chunks.append(f'<polyline points="{" ".join(points)}" fill="none" stroke="{palette[s%3]}" stroke-width="3"/>')
        for i, category in enumerate(e.categories):
            px = x + 30 + (i + .5) * plot_w / len(e.categories)
            chunks.append(f'<text x="{px}" y="{y+h-10}" text-anchor="middle" font-size="11" fill="{deck.theme["text"]}">{escape(category)}</text>')
    return "".join(chunks)


RENDERERS = {"text": _text, "shape": _shape, "image": _image, "table": _table, "chart": _chart}


def render(deck, slide, numbers=False):
    elements, assets = [], set()

    def draw(e, origin):
        if not e.visible:
            return ""
        style, box = effective(deck, slide, e)
        elements.append({"id": e.id, "name": e.name, "kind": e.kind, "origin": origin,
                         "role": e.role, "box": box.model_dump(), "style": style,
                         "overrides": e.style.model_dump(exclude_none=True)})
        if e.asset_id:
            assets.add(e.asset_id)
        content = "".join(draw(c, origin) for c in e.children) if e.kind == "group" else RENDERERS[e.kind](e, box, style, deck)
        badge_y = max(0, box.y * 72 - 18)
        badge = (f'<rect x="{box.x*72}" y="{badge_y}" width="52" height="16" fill="{deck.theme["primary"]}"/>'
                 f'<text x="{box.x*72+3}" y="{badge_y+12}" font-size="10" fill="{deck.theme["background"]}">{e.id}</text>') if numbers else ""
        return (f'<g data-element-id="{e.id}" data-origin="{origin}" style="cursor:pointer">'
                f'<title>{e.id} · {escape(e.name)} · {origin}</title>'
                f'<rect x="{box.x*72}" y="{box.y*72}" width="{box.width*72}" height="{box.height*72}" fill="transparent"/>{content}{badge}</g>')

    content = "".join(draw(e, deck.master.id) for e in deck.master.elements)
    content += "".join(draw(e, slide.id) for e in slide.elements)
    background = resolved_color(slide.background or "$background", deck)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {deck.width*72} {deck.height*72}" width="100%" height="100%">'
           f'<rect width="100%" height="100%" fill="{background}"/>{content}</svg>')
    return {"svg": svg, "elements": elements, "assets": sorted(assets), "slide_id": slide.id,
            "preview_kind": "scene", "note": "结构预览；外部软件的字体和排版可能存在差异"}
