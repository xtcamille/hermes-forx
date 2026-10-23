"""Portable scene model; identity, inheritance and validation live here."""
from __future__ import annotations

import re
import unicodedata
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .themes import COLOR_KEYS, color, theme

ELEMENT_STYLE_KEYS = {
    "text": {"font_size", "font_family", "bold", "color", "fill", "line", "line_width", "align"},
    "shape": {"fill", "line", "line_width"}, "image": set(),
    "table": {"font_size", "font_family", "bold", "color", "align"},
    "chart": {"font_size", "font_family", "color", "align"}, "group": set(),
}


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Style(Model):
    font_size: float | None = Field(None, ge=8, le=160)
    font_family: str | None = Field(None, min_length=1, max_length=100)
    bold: bool | None = None
    color: str | None = None
    fill: str | None = None
    line: str | None = None
    line_width: float | None = Field(None, ge=0, le=12)
    align: Literal["left", "center", "right"] | None = None

    @model_validator(mode="after")
    def valid_colors(self):
        for key in ("color", "fill", "line"):
            value = getattr(self, key)
            if value is not None and value != "none" and not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                if not value.startswith("$") or value[1:] not in COLOR_KEYS:
                    raise ValueError(f"{key} 必须是 #RRGGBB、none 或主题颜色引用")
            if key == "color" and value == "none":
                raise ValueError("文字颜色不能为 none")
        return self


class Box(Model):
    x: float = Field(ge=0, le=50)
    y: float = Field(ge=0, le=50)
    width: float = Field(gt=0, le=50)
    height: float = Field(gt=0, le=50)


class Series(Model):
    name: str = Field(min_length=1, max_length=100)
    values: list[float] = Field(min_length=1, max_length=100)


class Element(Model):
    id: str = Field(pattern=r"^E\d{4,}$")
    name: str = Field(min_length=1, max_length=128)
    kind: Literal["text", "shape", "image", "table", "chart", "group"]
    role: Literal["title", "body"] | None = None
    box: Box | None = None
    style: Style = Field(default_factory=Style)
    text: str = Field("", max_length=20000)
    shape: Literal["rect", "roundRect", "ellipse", "line"] | None = None
    asset_id: str | None = Field(None, pattern=r"^[a-f0-9]{64}$")
    crop: list[float] = Field(default_factory=lambda: [0, 0, 0, 0], min_length=4, max_length=4)
    rows: list[list[str]] = Field(default_factory=list, max_length=50)
    column_widths: list[float] = Field(default_factory=list, max_length=20)
    categories: list[str] = Field(default_factory=list, max_length=100)
    series: list[Series] = Field(default_factory=list, max_length=10)
    chart_type: Literal["column", "line", "pie"] = "column"
    children: list[Element] = Field(default_factory=list, max_length=60)
    visible: bool = True

    @model_validator(mode="after")
    def valid_content(self):
        if not set(self.style.model_dump(exclude_none=True)) <= ELEMENT_STYLE_KEYS[self.kind]:
            raise ValueError(f"{self.kind} 包含不适用于该对象的样式属性")
        if self.role and self.kind != "text":
            raise ValueError("只有文字占位符可以继承版式区域")
        if not self.role and self.box is None:
            raise ValueError("独立元素需要 box 位置和尺寸")
        if self.kind == "image" and not self.asset_id:
            raise ValueError("图片需要上传后的 asset_id")
        if any(v < 0 or v >= 1 for v in self.crop) or self.crop[0] + self.crop[2] >= 1 or self.crop[1] + self.crop[3] >= 1:
            raise ValueError("裁剪区域无效（顺序为 left, top, right, bottom）")
        if self.kind == "table":
            if not self.rows or not self.rows[0] or len(self.rows[0]) > 20:
                raise ValueError("表格需要 1–50 行、1–20 列")
            if any(len(row) != len(self.rows[0]) or any(len(cell) > 2000 for cell in row) for row in self.rows):
                raise ValueError("表格各行列数必须一致，单元格不超过 2000 字")
            if self.column_widths and (len(self.column_widths) != len(self.rows[0]) or any(v <= 0 for v in self.column_widths)):
                raise ValueError("column_widths 为与列数一致的正数权重")
        if self.kind == "chart":
            if not self.categories or not self.series or any(len(s.values) != len(self.categories) for s in self.series):
                raise ValueError("图表分类与每个系列的数据长度必须一致")
            if self.chart_type == "pie" and (len(self.series) != 1 or any(v < 0 for v in self.series[0].values) or sum(self.series[0].values) <= 0):
                raise ValueError("饼图需要一个非负且合计大于零的系列")
        if self.kind != "group" and self.children:
            raise ValueError("只有组合可以包含子元素")
        if self.kind == "group" and not self.children:
            raise ValueError("组合不能为空")
        if any(child.role for child in walk(self.children)):
            raise ValueError("组合中的元素不能保留页面占位符绑定")
        return self


class Layout(Model):
    id: Literal["L001", "L002", "L003", "L004", "L005", "L006", "L007", "L008", "L009", "L010"]
    name: str
    boxes: dict[str, Box]
    styles: dict[str, Style] = Field(default_factory=dict)


class SlideDraft(Model):
    title: str = Field(min_length=1, max_length=128)
    bullets: list[str] = Field(default_factory=list, max_length=12)
    layout_id: Literal["L001", "L002", "L003", "L004", "L005", "L006", "L007", "L008", "L009", "L010"] = "L003"
    notes: str = Field("", max_length=20000)
    elements: list[dict] = Field(default_factory=list, max_length=20)


class Master(Model):
    id: Literal["M001"] = "M001"
    name: str = "主母版"
    elements: list[Element]
    styles: dict[str, Style] = Field(default_factory=lambda: {"title": Style(), "body": Style()})


class Slide(Model):
    id: str = Field(pattern=r"^S\d{3,}$")
    name: str = Field(min_length=1, max_length=128)
    layout_id: str = "L003"
    background: str | None = None
    elements: list[Element] = Field(default_factory=list, max_length=60)
    notes: str = Field("", max_length=20000)


class Deck(Model):
    schema_version: Literal[1] = 1
    id: str = Field(default_factory=lambda: uuid.uuid4().hex, pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=128)
    width: float = 13.333333
    height: float = 7.5
    theme: dict = Field(default_factory=theme)
    master: Master
    layouts: list[Layout]
    slides: list[Slide] = Field(min_length=1, max_length=30)
    counters: dict[str, int] = Field(default_factory=lambda: {"E": 0, "S": 0})
    last_targets: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def integrity(self):
        if self.width not in (13.333333, 10.0) or self.height != 7.5:
            raise ValueError("首版支持 16:9 和 4:3 页面")
        expected = theme()
        if set(self.theme) != set(expected):
            raise ValueError("主题参数不完整或包含未知字段")
        for key in COLOR_KEYS:
            if not isinstance(self.theme[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", self.theme[key]):
                raise ValueError("主题颜色必须为 #RRGGBB")
        Style(font_size=self.theme["title_size"], font_family=self.theme["font_title"])
        Style(font_size=self.theme["body_size"], font_family=self.theme["font_body"])
        if self.theme["shape"] not in ("rect", "roundRect", "ellipse"):
            raise ValueError("主题形状不受支持")
        Style(line_width=self.theme["line_width"])
        lids = [layout.id for layout in self.layouts]
        if len(lids) != len(set(lids)) or any(s.layout_id not in lids for s in self.slides):
            raise ValueError("版式引用无效")
        text_keys = {"font_size", "font_family", "bold", "color", "align"}
        for styles in [self.master.styles, *[l.styles for l in self.layouts]]:
            if not set(styles) <= {"title", "body"} or any(not set(s.model_dump(exclude_none=True)) <= text_keys for s in styles.values()):
                raise ValueError("母版与版式支持标题和正文的字体、字号、字重、颜色及对齐样式")
        if any(set(layout.boxes) != {"title", "body"} for layout in self.layouts):
            raise ValueError("版式需要 title 和 body 占位区域")
        ids = [s.id for s in self.slides] + [e.id for e in all_elements(self)]
        if len(ids) != len(set(ids)):
            raise ValueError("页面或元素编号重复")
        for prefix in ("S", "E"):
            self.counters[prefix] = max(self.counters.get(prefix, 0), max((int(i[1:]) for i in ids if i.startswith(prefix)), default=0))
        for slide in self.slides:
            if len(list(walk(slide.elements))) + len(self.master.elements) > 60:
                raise ValueError("每页最多 60 个可寻址对象（包含组合及其子对象）")
            roles = [e.role for e in slide.elements if e.role]
            if len(roles) != len(set(roles)):
                raise ValueError("一页内同类占位符只能有一个")
            if slide.background is not None:
                Style(fill=slide.background)
            for e in walk(slide.elements):
                if e.role and e.role not in layout_for(self, slide).boxes:
                    raise ValueError("当前版式没有对应占位符")
        for e in walk(self.master.elements):
            if e.role or e.kind in ("table", "chart", "group"):
                raise ValueError("母版公共对象支持独立文字、图片和形状")
        return self


def walk(elements):
    for element in elements:
        yield element
        yield from walk(element.children)


def all_elements(deck):
    yield from walk(deck.master.elements)
    for slide in deck.slides:
        yield from walk(slide.elements)


def allocate(deck, prefix):
    deck.counters[prefix] += 1
    return prefix + str(deck.counters[prefix]).zfill(4 if prefix == "E" else 3)


def layout_for(deck, slide):
    return next(layout for layout in deck.layouts if layout.id == slide.layout_id)


def effective(deck, slide, element):
    role = element.role or "body"
    p = deck.theme
    style = dict(font_size=p["title_size" if role == "title" else "body_size"],
                 font_family=p["font_title" if role == "title" else "font_body"],
                 bold=role == "title", color="$text", fill="$surface" if element.kind == "shape" else "none", line="none",
                 line_width=p["line_width"], align="left")
    if element.role:
        style.update(deck.master.styles.get(role, Style()).model_dump(exclude_none=True))
        style.update(layout_for(deck, slide).styles.get(role, Style()).model_dump(exclude_none=True))
    style.update(element.style.model_dump(exclude_none=True))
    return style, element.box or layout_for(deck, slide).boxes[element.role]


def resolved_color(value, deck):
    return color(value, deck.theme)


def locate(deck, target, slide_id=None):
    for owner, elements in [(deck.master, deck.master.elements)] + [(s, s.elements) for s in deck.slides]:
        for element in walk(elements):
            if element.id == target:
                if slide_id and owner.id != slide_id:
                    raise ValueError(f"{target} 不属于 {slide_id}，实际来源为 {owner.id}")
                return owner, element
    raise ValueError(f"未找到元素 {target}")


def make_layouts(width):
    right = width - 1.2
    specifications = [
        ("封面", (0.8, 2.0, width - 1.6, 1.5), (0.85, 3.8, width - 1.7, 1.4)),
        ("目录", (0.6, 0.7, right, 0.85), (0.8, 2.0, width - 1.6, 4.5)),
        ("标题正文", (0.6, 0.7, right, 0.85), (0.6, 1.9, right, 4.7)),
        ("图文", (0.6, 0.7, right, 0.85), (0.6, 1.9, width / 2 - 0.9, 4.7)),
        ("结束页", (0.8, 2.5, width - 1.6, 1.5), (0.85, 4.2, width - 1.7, 1.0)),
        ("时间轴", (0.6, 0.7, right, 0.85), (0.6, 2.0, right, 4.5)),
        ("多列卡片", (0.6, 0.7, right, 0.85), (0.6, 1.9, right, 4.7)),
        ("关键指标", (0.6, 0.7, right, 0.85), (0.6, 2.0, right, 4.5)),
        ("四象限SWOT", (0.6, 0.7, right, 0.85), (0.6, 1.9, right, 4.7)),
        ("方案对比", (0.6, 0.7, right, 0.85), (0.6, 1.9, right, 4.7)),
    ]
    return [Layout(id=f"L{i:03}", name=n, boxes={"title": Box(x=a[0], y=a[1], width=a[2], height=a[3]),
                   "body": Box(x=b[0], y=b[1], width=b[2], height=b[3])})
            for i, (n, a, b) in enumerate(specifications, 1)]


def new_deck(name, slides, theme_name="business", ratio="16:9"):
    if ratio not in ("16:9", "4:3"):
        raise ValueError("首版支持 16:9 或 4:3 页面")
    width = 10.0 if ratio == "4:3" else 13.333333
    deck = Deck(name=name, width=width, theme=theme(theme_name), master=Master(elements=[]),
                layouts=make_layouts(width), slides=[Slide(id="S001", name="占位")])
    deck.slides.clear()
    deck.counters["S"] = 0
    for text, box in [("FORX", Box(x=width - 2.1, y=0.15, width=1.5, height=0.4)),
                      (name, Box(x=0.6, y=7.05, width=width - 1.2, height=0.3))]:
        deck.master.elements.append(Element(id=allocate(deck, "E"), name="品牌标识" if text == "FORX" else "页脚",
                                           kind="text", box=box, text=text,
                                           style=Style(font_size=12, color="$muted")))
    for spec in slides:
        add_slide(deck, spec)
    return Deck.model_validate(deck.model_dump())


def add_slide(deck, spec):
    spec = SlideDraft.model_validate(spec).model_dump()
    title = str(spec.get("title", "新页面"))
    slide = Slide(id=allocate(deck, "S"), name=title[:128] or "新页面", layout_id=spec.get("layout_id", "L003"), notes=spec.get("notes", ""))
    for role, text in (("title", title), ("body", "\n".join(spec.get("bullets", [])))):
        if role == "body" and not text:
            continue
        slide.elements.append(Element(id=allocate(deck, "E"), name="主标题" if role == "title" else "正文",
                                      kind="text", role=role, text=text))
    for raw in spec.get("elements", []):
        if not isinstance(raw, dict):
            continue
        data = dict(raw)
        if "kind" not in data:
            continue
        data.setdefault("name", "元素")
        def assign(item):
            item["id"] = allocate(deck, "E")
            for child in item.get("children", []):
                if isinstance(child, dict):
                    assign(child)
        assign(data)
        try:
            slide.elements.append(Element.model_validate(data))
        except Exception:
            pass
    deck.slides.append(slide)
    return slide


def display_width(text):
    return sum(1 if unicodedata.east_asian_width(c) in "WF" else 0.55 for c in text)


def quality_issues(deck):
    issues = []
    for slide in deck.slides:
        for e in list(walk(deck.master.elements)) + list(walk(slide.elements)):
            if not e.visible:
                continue
            style, box = effective(deck, slide, e)
            if box.x + box.width > deck.width + 0.01 or box.y + box.height > deck.height + 0.01:
                issues.append({"slide_id": slide.id, "element_id": e.id, "kind": "out_of_bounds", "message": "元素超出页面"})
            if e.kind == "text" and e.text:
                capacity = max(1, (box.width * 72 - 10.08) / style["font_size"])
                lines = sum(max(1, int(display_width(t) / capacity) + 1) for t in e.text.split("\n"))
                if lines * style["font_size"] * 1.2 > box.height * 72 - 5.76:
                    issues.append({"slide_id": slide.id, "element_id": e.id, "kind": "text_overflow", "message": "文字可能溢出，请缩写、扩框或调整字号"})
    return issues
