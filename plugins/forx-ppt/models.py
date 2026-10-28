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


def extract_bullets_from_text(text: str) -> list[str]:
    if not text:
        return []
    lines = [line.strip().lstrip("-*•0123456789.、 \t") for line in text.split("\n") if line.strip()]
    if len(lines) > 1:
        return [l for l in lines if l]
    colon_idx = max(text.find(":"), text.find("："))
    target = text[colon_idx + 1:] if colon_idx != -1 else text
    parts = re.split(r"[；;。，,、|]", target)
    parts = [p.strip().lstrip("-*•0123456789.、 \t") for p in parts if len(p.strip()) >= 2]
    if len(parts) >= 2:
        return parts[:6]
    clean = text.strip().lstrip("-*•0123456789.、 \t")
    return [clean] if clean else []


def default_bullets_for_layout(layout_id: str, title: str = "") -> list[str]:
    defaults = {
        "L001": [f"{title or '商业演示文稿'}：全景战略规划与核心业务实践汇报", "汇报人：产品技术委员会 · 2026年Q4"],
        "L002": [
            "01 背景与挑战：高并发业务瓶颈与研发生态痛点",
            "02 架构与突破：微内核解耦与参数化矢量渲染引擎",
            "03 落地与成效：生产级业务闭环与核心指标达成",
            "04 展望与规划：下一步平台化生态与多模态AI演进",
        ],
        "L003": [
            f"【核心洞察】{title or '核心观点'} 具备高度确定性与技术壁垒",
            "• 架构解耦推进：通过模块化微内核拆解，大幅降低系统维护与升级开销",
            "• 协同效率提升：打通端到端全链路可视化交付，实现敏捷迭代与即时反馈",
            "• 业务价值保障：兼顾高可用容灾与合规离线安全，支撑长期业务增长",
        ],
        "L004": [
            "【核心技术自研】基于 AST 语意树的文本大纲自动分块与版式智能匹配算法，实现毫秒级自适应排版",
            "【端侧安全隔离】离线沙箱环境安全执行，用户原始数据与产物不离开本地磁盘",
            "【全生命周期闭环】统一原子化操作命令集，支持无限层级无损撤销与版本时光机",
        ],
        "L005": ["感谢各位专家与评委的倾听与指导！", "欢迎提问与深入探讨 · Q & A"],
        "L006": [
            "阶段一 (Q1 启动期)：需求调研与架构选型 — 完成基准性能评测与核心链路 PoC 原型验证",
            "阶段二 (Q2 攻坚期)：引擎研发与功能内测 — 实现参数化矢量排版引擎与离线状态库构建",
            "阶段三 (Q3 试点期)：业务试点与压力测试 — 在重点业务场景完成端到端落地并达成 SLA 目标",
            "阶段四 (Q4 推广期)：全量推广与生态开放 — 推动平台化能力开放与行业规模化应用落地",
        ],
        "L007": [
            "模块化解耦体系：采用插件化松耦合架构，将核心调度引擎与业务模块彻底解耦，系统维护效率提升 40%",
            "自适应参数化排版：基于矢量几何计算的高质量渲染层，确保多分辨率下像素级对齐与极佳阅读体验",
            "私有安全离线存储：依托本地轻量数据库与事务级快照机制，全面保障企业数字资产安全与隐私合规",
        ],
        "L008": [
            "99.99% 金融级可用性：依托异地双活与全自动熔断降级架构，全年故障恢复时间低于 30 秒",
            "300% 创作排版提效：AI智能大纲提炼与版式自动匹配，将传统制作耗时从小时级缩减至分钟级",
            "50,000+ 企业团队信赖：已在金融、科技、咨询等高标准场景稳定运行，服务数万专业团队",
        ],
        "L009": [
            "优势 (S)：轻量级微内核架构与极低资源开销，毫秒级响应并天然支持无网络离线运行",
            "劣势 (W)：初期外部生态插件库仍在快速建设中，高级第三方模板丰富度待进一步拓展",
            "机会 (O)：大模型 Native 应用全面普及，专业级结构化生产力工具需求迎来爆发式增长",
            "威胁 (T)：开源工具快速演进与技术同质化竞争，需持续深化核心算法壁垒与极致用户体验",
        ],
        "L010": [
            "方案 A (传统集中式架构)：改造成本低、团队上手快、短期维护简单，但在超大规模并发下扩展受限",
            "方案 B (现代云原生微服务)：弹性伸缩强、故障物理隔离、性能上限极高，架构长期演进优势显著",
        ],
    }
    return defaults.get(layout_id, defaults["L003"])


def _split_bullet_text(b: str) -> tuple[str, str]:
    for sep in ("：", ":", " - ", "—", "|"):
        if sep in b:
            parts = b.split(sep, 1)
            return parts[0].strip(), parts[1].strip()
    return b.strip(), ""


def _parse_metric_item(b: str) -> tuple[str, str, str]:
    m = re.match(r"^([0-9.,%+\-xX/]+[a-zA-Z%+]?|Top\s*\d+|No\.\d+)\s*(.*)", b.strip())
    if m:
        val = m.group(1).strip()
        rest = m.group(2).strip()
        lbl, desc = _split_bullet_text(rest)
        if not desc and len(lbl) > 10:
            desc = lbl[8:]
            lbl = lbl[:8]
        return val, lbl or "关键指标", desc or "业务核心量化突破与价值呈现"
    m2 = re.search(r"(\d+(\.\d+)?%|\d+[+万千亿]|\d+x|\d+\.\d+)", b)
    if m2:
        val = m2.group(1)
        rest = b.replace(val, "").strip(" :：-—|")
        lbl, desc = _split_bullet_text(rest)
        return val, lbl or "量化指标", desc or "高标准执行与效能提升"
    head, tail = _split_bullet_text(b)
    return "100%", head or "核心指标", tail or "全流程闭环落地保障"


def expand_layout_elements(deck, layout_id: str, title: str, bullets: list[str]) -> list[Element]:
    """Expand structured layout into fine-grained, independently selectable cards, badges, and text blocks."""
    W = deck.width
    elements: list[Element] = []

    # 1. Slide Title (Always present as role="title" to guarantee layout inheritance and compatibility)
    elements.append(
        Element(
            id=allocate(deck, "E"),
            name="主标题",
            kind="text",
            role="title",
            text=title,
        )
    )

    if layout_id == "L001":  # 封面
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="封面装饰线",
                kind="shape",
                shape="roundRect",
                box=Box(x=0.85, y=3.7, width=2.0, height=0.08),
                style=Style(fill="$primary"),
            )
        )
        sub_text = "\n".join(bullets) if bullets else "商业战略规划与业务落地汇报 · 2026"
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="副标题与作者",
                kind="text",
                box=Box(x=0.85, y=3.95, width=round(W - 1.7, 3), height=1.6),
                text=sub_text,
                style=Style(font_size=18, color="$muted"),
            )
        )
        return elements

    if layout_id == "L005":  # 结束页
        thank_text = "\n".join(bullets) if bullets else "感谢聆听 · 敬请批评指正\nQ & A"
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="致谢与问答",
                kind="text",
                box=Box(x=0.85, y=4.2, width=round(W - 1.7, 3), height=1.5),
                text=thank_text,
                style=Style(font_size=20, align="center", color="$muted"),
            )
        )
        return elements

    if layout_id == "L007":  # 多列卡片
        items = bullets[:4] or default_bullets_for_layout("L007")
        count = max(2, min(4, len(items)))
        gap = 0.3
        card_w = (W - 1.2 - (count - 1) * gap) / count
        for i, item in enumerate(items[:count]):
            cx = 0.6 + i * (card_w + gap)
            head, tail = _split_bullet_text(item)
            c_title = head or f"核心支柱 0{i+1}"
            c_body = tail or item
            badge_w = min(1.3, card_w - 0.5)
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"卡片背景 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(cx, 3), y=1.9, width=round(card_w, 3), height=4.8),
                    style=Style(fill="$surface", line="$muted", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"卡片标签 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(cx + 0.25, 3), y=2.2, width=round(badge_w, 3), height=0.35),
                    style=Style(fill="$primary"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"标签文字 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.25, 3), y=2.2, width=round(badge_w, 3), height=0.35),
                    text=f"模块 0{i+1}",
                    style=Style(font_size=11, bold=True, color="$background", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"卡片标题 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.25, 3), y=2.7, width=round(card_w - 0.5, 3), height=0.75),
                    text=c_title,
                    style=Style(font_size=16, bold=True, color="$text"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"卡片正文 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.25, 3), y=3.55, width=round(card_w - 0.5, 3), height=2.9),
                    text=c_body,
                    style=Style(font_size=12, color="$muted"),
                )
            )
        return elements

    if layout_id == "L008":  # 关键指标 / KPI
        items = bullets[:4] or default_bullets_for_layout("L008")
        count = max(2, min(4, len(items)))
        gap = 0.3
        card_w = (W - 1.2 - (count - 1) * gap) / count
        for i, item in enumerate(items[:count]):
            cx = 0.6 + i * (card_w + gap)
            val, lbl, desc = _parse_metric_item(item)
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"指标卡片 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(cx, 3), y=2.0, width=round(card_w, 3), height=4.6),
                    style=Style(fill="$surface", line="$muted", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"装饰线 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(cx + 0.3, 3), y=2.15, width=round(card_w - 0.6, 3), height=0.06),
                    style=Style(fill="$primary"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"指标数值 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.2, 3), y=2.45, width=round(card_w - 0.4, 3), height=1.3),
                    text=val,
                    style=Style(font_size=38, bold=True, color="$primary", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"指标名称 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.2, 3), y=3.85, width=round(card_w - 0.4, 3), height=0.6),
                    text=lbl,
                    style=Style(font_size=15, bold=True, color="$text", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"指标说明 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.25, 3), y=4.5, width=round(card_w - 0.5, 3), height=1.8),
                    text=desc,
                    style=Style(font_size=12, color="$muted", align="center"),
                )
            )
        return elements

    if layout_id == "L006":  # 时间轴
        items = bullets[:4] or default_bullets_for_layout("L006")
        count = max(2, min(4, len(items)))
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="时间轴中线",
                kind="shape",
                shape="line",
                box=Box(x=0.9, y=3.8, width=round(W - 1.8, 3), height=0.01),
                style=Style(line="$primary", line_width=3),
            )
        )
        for i, item in enumerate(items[:count]):
            node_x = 0.9 + i * ((W - 1.8) / (count - 1))
            col_w = min(2.7, (W - 1.8) / count)
            left_x = max(0.5, min(W - col_w - 0.5, node_x - col_w / 2))
            head, tail = _split_bullet_text(item)
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"节点圆点 {i+1}",
                    kind="shape",
                    shape="ellipse",
                    box=Box(x=round(node_x - 0.2, 3), y=3.6, width=0.4, height=0.4),
                    style=Style(fill="$primary", line="$background", line_width=2),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"阶段卡片 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(left_x, 3), y=2.1, width=round(col_w, 3), height=1.35),
                    style=Style(fill="$surface", line="$muted", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"阶段标识 {i+1}",
                    kind="text",
                    box=Box(x=round(left_x + 0.15, 3), y=2.2, width=round(col_w - 0.3, 3), height=0.4),
                    text=f"阶段 0{i+1}",
                    style=Style(font_size=11, bold=True, color="$primary", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"阶段名称 {i+1}",
                    kind="text",
                    box=Box(x=round(left_x + 0.15, 3), y=2.65, width=round(col_w - 0.3, 3), height=0.7),
                    text=head or f"里程碑 {i+1}",
                    style=Style(font_size=13, bold=True, color="$text", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"交付卡片 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(left_x, 3), y=4.2, width=round(col_w, 3), height=2.4),
                    style=Style(fill="$surface", line="$muted", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"交付细节 {i+1}",
                    kind="text",
                    box=Box(x=round(left_x + 0.15, 3), y=4.35, width=round(col_w - 0.3, 3), height=2.1),
                    text=tail or item,
                    style=Style(font_size=12, color="$muted"),
                )
            )
        return elements

    if layout_id == "L009":  # 四象限 SWOT
        items = bullets[:4] or default_bullets_for_layout("L009")
        col_w = (W - 1.2 - 0.3) / 2
        row_h = 2.35
        quad_specs = [
            ("优势 (S)", "$primary", 0.6, 1.9),
            ("劣势 (W)", "#ff9500", 0.6 + col_w + 0.3, 1.9),
            ("机会 (O)", "#34c759", 0.6, 4.45),
            ("威胁 (T)", "#ff3b30", 0.6 + col_w + 0.3, 4.45),
        ]
        for i, (b_tag, col_val, qx, qy) in enumerate(quad_specs):
            item = items[i] if i < len(items) else f"{b_tag} 战略分析"
            head, tail = _split_bullet_text(item)
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"象限卡片 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(qx, 3), y=round(qy, 3), width=round(col_w, 3), height=round(row_h, 3)),
                    style=Style(fill="$surface", line="$muted", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"象限标签 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(qx + 0.2, 3), y=round(qy + 0.2, 3), width=1.4, height=0.35),
                    style=Style(fill=col_val),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"标签文字 {i+1}",
                    kind="text",
                    box=Box(x=round(qx + 0.2, 3), y=round(qy + 0.2, 3), width=1.4, height=0.35),
                    text=b_tag,
                    style=Style(font_size=11, bold=True, color="$background", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"象限标题 {i+1}",
                    kind="text",
                    box=Box(x=round(qx + 1.8, 3), y=round(qy + 0.18, 3), width=round(col_w - 2.0, 3), height=0.4),
                    text=head or b_tag,
                    style=Style(font_size=14, bold=True, color="$text"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"象限分析 {i+1}",
                    kind="text",
                    box=Box(x=round(qx + 0.2, 3), y=round(qy + 0.65, 3), width=round(col_w - 0.4, 3), height=1.55),
                    text=tail or item,
                    style=Style(font_size=12, color="$muted"),
                )
            )
        return elements

    if layout_id == "L010":  # 方案对比
        items = bullets[:2] or default_bullets_for_layout("L010")[:2]
        col_w = (W - 1.2 - 0.4) / 2
        specs = [
            (0.6, "$surface", "方案 A · 当前基准", 1, False),
            (0.6 + col_w + 0.4, "$primary", "方案 B · 目标演进 (推荐)", 2, True),
        ]
        for i, (cx, b_fill, b_txt, b_width, is_rec) in enumerate(specs):
            item = items[i] if i < len(items) else ("方案 A" if i == 0 else "方案 B")
            head, tail = _split_bullet_text(item)
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"对比卡片 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(cx, 3), y=1.9, width=round(col_w, 3), height=4.8),
                    style=Style(fill="$surface", line="$primary" if is_rec else "$muted", line_width=b_width),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"方案标识 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=round(cx + 0.3, 3), y=2.15, width=round(col_w - 0.6, 3), height=0.55),
                    style=Style(fill=b_fill, line="$primary" if not is_rec else "none", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"标识文字 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.3, 3), y=2.2, width=round(col_w - 0.6, 3), height=0.45),
                    text=b_txt,
                    style=Style(font_size=14, bold=True, color="$background" if is_rec else "$primary", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"方案标题 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.35, 3), y=2.9, width=round(col_w - 0.7, 3), height=0.6),
                    text=head or ("方案 A" if i == 0 else "方案 B"),
                    style=Style(font_size=16, bold=True, color="$text"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"方案详述 {i+1}",
                    kind="text",
                    box=Box(x=round(cx + 0.35, 3), y=3.6, width=round(col_w - 0.7, 3), height=2.9),
                    text=tail or item,
                    style=Style(font_size=13, color="$muted"),
                )
            )
        return elements

    if layout_id == "L004":  # 图文双栏
        card_w = round(W / 2 - 0.9, 3)
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="左侧文本卡片",
                kind="shape",
                shape="roundRect",
                box=Box(x=0.6, y=1.9, width=card_w, height=4.8),
                style=Style(fill="$surface", line="$muted", line_width=1),
            )
        )
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="左侧正文叙述",
                kind="text",
                box=Box(x=0.85, y=2.15, width=round(card_w - 0.5, 3), height=4.3),
                text="\n\n".join(bullets) if bullets else "正文内容要点与深度阐述",
                style=Style(font_size=13, color="$text"),
            )
        )
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="右侧配图占位卡",
                kind="shape",
                shape="roundRect",
                box=Box(x=round(W / 2 + 0.3, 3), y=1.9, width=card_w, height=4.8),
                style=Style(fill="$surface", line="$muted", line_width=1),
            )
        )
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="生图引导提示",
                kind="text",
                box=Box(x=round(W / 2 + 0.6, 3), y=3.8, width=round(card_w - 0.6, 3), height=1.2),
                text="🎨 可点击顶部【AI生图】为本页生成专属插图",
                style=Style(font_size=14, color="$muted", align="center"),
            )
        )
        return elements

    if layout_id == "L002":  # 目录导航
        items = bullets[:4] or default_bullets_for_layout("L002")
        for i, item in enumerate(items[:4]):
            y_pos = 2.0 + i * 1.15
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"目录条目卡片 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=0.8, y=round(y_pos, 3), width=round(W - 1.6, 3), height=0.95),
                    style=Style(fill="$surface", line="$muted", line_width=1),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"章节序号卡 {i+1}",
                    kind="shape",
                    shape="roundRect",
                    box=Box(x=1.05, y=round(y_pos + 0.2, 3), width=0.65, height=0.55),
                    style=Style(fill="$primary"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"章节序号 {i+1}",
                    kind="text",
                    box=Box(x=1.05, y=round(y_pos + 0.22, 3), width=0.65, height=0.55),
                    text=f"0{i+1}",
                    style=Style(font_size=14, bold=True, color="$background", align="center"),
                )
            )
            elements.append(
                Element(
                    id=allocate(deck, "E"),
                    name=f"章节标题 {i+1}",
                    kind="text",
                    box=Box(x=1.9, y=round(y_pos + 0.22, 3), width=round(W - 3.0, 3), height=0.55),
                    text=item,
                    style=Style(font_size=15, bold=True, color="$text"),
                )
            )
        return elements

    # L003 standard body text (inherits layout box)
    if bullets:
        elements.append(
            Element(
                id=allocate(deck, "E"),
                name="正文",
                kind="text",
                role="body",
                text="\n".join(bullets),
            )
        )
    return elements


def add_slide(deck, spec):
    spec = SlideDraft.model_validate(spec).model_dump()
    title = str(spec.get("title", "新页面"))
    layout_id = spec.get("layout_id", "L003")
    notes = spec.get("notes", "")
    slide = Slide(id=allocate(deck, "S"), name=title[:128] or "新页面", layout_id=layout_id, notes=notes)

    raw_bullets = spec.get("bullets", [])
    bullets = [str(b).strip() for b in raw_bullets if str(b).strip()]
    if not bullets and not spec.get("elements"):
        if notes:
            bullets = extract_bullets_from_text(notes)
        if not bullets:
            bullets = default_bullets_for_layout(layout_id, title)

    # When no explicit custom elements provided, generate fine-grained layout elements
    if not spec.get("elements"):
        expanded = expand_layout_elements(deck, layout_id, title, bullets)
        slide.elements.extend(expanded)
    else:
        # Title is always elements[0]
        slide.elements.append(
            Element(id=allocate(deck, "E"), name="主标题", kind="text", role="title", text=title)
        )
        if bullets:
            slide.elements.append(
                Element(id=allocate(deck, "E"), name="正文", kind="text", role="body", text="\n".join(bullets))
            )
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
