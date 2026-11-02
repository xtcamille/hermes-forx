"""Document themes are independent of the desktop application's appearance."""
from copy import deepcopy


THEMES = {
    "business": {
        "name": "商务简洁", "background": "#FFFFFF", "text": "#17243B",
        "muted": "#52627A", "primary": "#2459A8", "accent": "#168C92",
        "surface": "#EDF2F8", "font_title": "Microsoft YaHei",
        "font_body": "Microsoft YaHei", "title_size": 32, "body_size": 20,
        "shape": "rect", "line_width": 1.0,
    },
    "technology": {
        "name": "深色科技", "background": "#101C30", "text": "#F2F6FF",
        "muted": "#BCCBE2", "primary": "#64AAFF", "accent": "#49DEC5",
        "surface": "#20314D", "font_title": "Microsoft YaHei",
        "font_body": "Microsoft YaHei", "title_size": 34, "body_size": 20,
        "shape": "roundRect", "line_width": 1.5,
    },
    "minimal": {
        "name": "清新极简", "background": "#F7F9F5", "text": "#223C32",
        "muted": "#5B7364", "primary": "#35745B", "accent": "#B16B36",
        "surface": "#E7EEE6", "font_title": "Microsoft YaHei",
        "font_body": "Microsoft YaHei", "title_size": 32, "body_size": 19,
        "shape": "rect", "line_width": 0.75,
    },
    "crimson": {
        "name": "活力果红", "background": "#FFFFFF", "text": "#1D1D1F",
        "muted": "#86868B", "primary": "#FF3B30", "accent": "#FF9500",
        "surface": "#F5F5F7", "font_title": "Microsoft YaHei",
        "font_body": "Microsoft YaHei", "title_size": 32, "body_size": 20,
        "shape": "roundRect", "line_width": 1.0,
    },
    "royal": {
        "name": "尊贵雅致", "background": "#0F0C20", "text": "#F5F3FF",
        "muted": "#9E97C2", "primary": "#7C3AED", "accent": "#C084FC",
        "surface": "#1E1838", "font_title": "Microsoft YaHei",
        "font_body": "Microsoft YaHei", "title_size": 34, "body_size": 20,
        "shape": "roundRect", "line_width": 1.25,
    },
    "elegant": {
        "name": "香槟轻奢", "background": "#FDFBF7", "text": "#2C2523",
        "muted": "#7E7571", "primary": "#A3704C", "accent": "#D4A373",
        "surface": "#F4EFEA", "font_title": "Microsoft YaHei",
        "font_body": "Microsoft YaHei", "title_size": 32, "body_size": 19,
        "shape": "rect", "line_width": 1.0,
    },
}
COLOR_KEYS = {"background", "text", "muted", "primary", "accent", "surface"}
STYLE_KEYS = {"font_size", "font_family", "bold", "color", "fill", "line", "line_width", "align"}


def theme(name="business"):
    if not isinstance(name, str) or name not in THEMES:
        raise ValueError(f"未知主题，支持的主题为：{'、'.join(THEMES.keys())}")
    return deepcopy(THEMES[name])


def color(value, palette):
    return palette[value[1:]] if value.startswith("$") else value

