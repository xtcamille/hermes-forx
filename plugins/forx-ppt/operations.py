"""Validated, atomic edits. Planning never mutates the authoritative document."""
from __future__ import annotations

from copy import deepcopy
from typing import Literal

from pydantic import Field

from .models import (ELEMENT_STYLE_KEYS, Box, Deck, Element, Model, Style, add_slide, allocate, effective,
                     layout_for, locate, walk)
from .themes import STYLE_KEYS, theme


class Operation(Model):
    action: Literal["update_element", "add_element", "delete_element", "move_element",
                    "add_slide", "delete_slide", "duplicate_slide", "move_slide",
                    "update_slide", "master_style", "layout_style", "theme",
                    "reset_style", "group", "ungroup", "rename"]
    target: str = ""
    slide_id: str | None = None
    changes: dict = Field(default_factory=dict)
    element: dict | None = None
    slide: dict | None = None
    ids: list[str] = Field(default_factory=list, max_length=60)
    index: int | None = Field(None, ge=0, le=29)
    properties: list[str] = Field(default_factory=list)


def _slide(deck, target):
    for slide in deck.slides:
        if slide.id == target:
            return slide
    raise ValueError(f"未找到页面 {target}")


def _parent(elements, target):
    for e in elements:
        if e.id == target:
            return elements
        found = _parent(e.children, target)
        if found is not None:
            return found
    return None


def _transform(elements, old, new, deck, slide):
    sx, sy = new.width / old.width, new.height / old.height
    for e in walk(elements):
        b = e.box
        if e.kind in {"text", "table", "chart"} and sy != 1:
            e.style.font_size = effective(deck, slide, e)[0]["font_size"] * sy
        e.box = Box(x=new.x + (b.x - old.x) * sx, y=new.y + (b.y - old.y) * sy,
                    width=b.width * sx, height=b.height * sy)


def _update_element(deck, op):
    owner, e = locate(deck, op.target, op.slide_id)
    common = {"name", "box", "style", "visible"}
    allowed = common | {"text": {"text"}, "shape": {"shape"}, "image": {"asset_id", "crop"},
                        "table": {"rows", "column_widths"}, "chart": {"text", "categories", "series", "chart_type"},
                        "group": set()}[e.kind]
    if e.kind == "group":
        allowed.discard("style")
    if not set(op.changes) <= allowed:
        raise ValueError("包含不支持的元素属性；不能修改身份、类型或继承来源")
    updated = e.model_dump()
    updated.update(op.changes)
    if "style" in op.changes:
        if not isinstance(op.changes["style"], dict):
            raise ValueError("style 需要是属性对象")
        updated["style"] = {**e.style.model_dump(exclude_none=True), **op.changes["style"]}
    candidate = Element.model_validate(updated)
    if e.kind == "group" and "box" in op.changes:
        _transform(candidate.children, e.box, candidate.box, deck, owner)
    for key in op.changes:
        setattr(e, key, getattr(candidate, key))
    if e.kind == "group":
        e.children = candidate.children


def _add_element(deck, op):
    owner = deck.master if op.target == deck.master.id else _slide(deck, op.slide_id or op.target)
    if not op.element or "id" in op.element:
        raise ValueError("提供 element，身份编号由系统分配")
    raw = deepcopy(op.element)

    def assign(data):
        data["id"] = allocate(deck, "E")
        for child in data.get("children", []):
            assign(child)

    assign(raw)
    owner.elements.append(Element.model_validate(raw))


def _delete_element(deck, op):
    owner, e = locate(deck, op.target, op.slide_id)
    _parent(owner.elements, e.id).remove(e)


def _move_element(deck, op):
    owner, e = locate(deck, op.target)
    if owner.id == deck.master.id:
        raise ValueError("母版公共对象不能直接移到单页，请保留来源并显式添加独立对象")
    destination = _slide(deck, op.slide_id)
    if e.role:
        e.box = deepcopy(e.box or layout_for(deck, owner).boxes[e.role])
        e.style = Style.model_validate(effective(deck, owner, e)[0])
        e.role = None
    _parent(owner.elements, e.id).remove(e)
    destination.elements.append(e)


def _add_slide(deck, op):
    added = add_slide(deck, op.slide or {"title": "新页面", "bullets": []})
    if op.index is not None:
        deck.slides.remove(added)
        deck.slides.insert(op.index, added)


def _delete_slide(deck, op):
    deck.slides.remove(_slide(deck, op.target))


def _duplicate_slide(deck, op):
    source = _slide(deck, op.target)
    slide = source.model_copy(deep=True)
    slide.id = allocate(deck, "S")
    slide.name = source.name[:124] + " 副本"
    for e in walk(slide.elements):
        e.id = allocate(deck, "E")
    deck.slides.insert(deck.slides.index(source) + 1, slide)


def _move_slide(deck, op):
    if op.index is None or op.index >= len(deck.slides):
        raise ValueError("需要有效的 index（从 0 开始）")
    slide = _slide(deck, op.target)
    deck.slides.remove(slide)
    deck.slides.insert(op.index, slide)


def _update_slide(deck, op):
    if not set(op.changes) <= {"name", "background", "notes", "layout_id"}:
        raise ValueError("不支持的页面属性")
    slide = _slide(deck, op.target)
    for key, value in op.changes.items():
        setattr(slide, key, value)


def _master_style(deck, op):
    if op.target not in ("title", "body"):
        raise ValueError("母版样式 target 为 title 或 body")
    if not set(op.changes) <= {"font_size", "font_family", "bold", "color", "align"}:
        raise ValueError("母版文字样式支持字体、字号、字重、颜色和对齐；填充与边框请编辑母版公共对象")
    current = deck.master.styles.get(op.target, Style()).model_dump(exclude_none=True)
    deck.master.styles[op.target] = Style.model_validate({**current, **op.changes})


def _layout_style(deck, op):
    layout = next((l for l in deck.layouts if l.id == op.target), None)
    role = op.changes.get("role")
    if not layout or role not in ("title", "body") or not set(op.changes) <= {"role", "style", "box"}:
        raise ValueError("提供有效版式、role、style 或 box")
    if "style" in op.changes:
        if not isinstance(op.changes["style"], dict):
            raise ValueError("版式 style 需要是属性对象")
        if not set(op.changes["style"]) <= {"font_size", "font_family", "bold", "color", "align"}:
            raise ValueError("版式文字样式支持字体、字号、字重、颜色和对齐")
        current = layout.styles.get(role, Style()).model_dump(exclude_none=True)
        layout.styles[role] = Style.model_validate({**current, **op.changes["style"]})
    if "box" in op.changes:
        layout.boxes[role] = Box.model_validate(op.changes["box"])


def _theme(deck, op):
    data = dict(op.changes)
    preset = data.pop("preset", None)
    if not set(data) <= set(deck.theme):
        raise ValueError("未知主题参数")
    deck.theme = {**(theme(preset) if preset else deck.theme), **data}
    if op.properties:
        if not set(op.properties) <= STYLE_KEYS:
            raise ValueError("不支持的覆盖属性")
        styles = [e.style for e in walk(deck.master.elements)]
        styles += list(deck.master.styles.values())
        for layout in deck.layouts:
            styles += list(layout.styles.values())
        for slide in deck.slides:
            styles += [e.style for e in walk(slide.elements)]
        for style in styles:
            for key in op.properties:
                setattr(style, key, None)


def _reset_style(deck, op):
    _, e = locate(deck, op.target, op.slide_id)
    if not op.properties or not set(op.properties) <= STYLE_KEYS | {"box"}:
        raise ValueError("请明确要恢复继承的属性")
    for key in op.properties:
        if key == "box":
            if not e.role:
                raise ValueError("独立对象不能清除位置")
            e.box = None
        else:
            setattr(e.style, key, None)


def _group(deck, op):
    slide = _slide(deck, op.slide_id or op.target)
    if len(set(op.ids)) < 2:
        raise ValueError("至少选择两个不同的页面顶层对象")
    selected = [e for e in slide.elements if e.id in op.ids]
    if len(selected) != len(op.ids):
        raise ValueError("只能组合当前页的顶层对象")
    for e in selected:
        style, box = effective(deck, slide, e)
        e.box, e.role, e.style = deepcopy(box), None, Style.model_validate({k: v for k, v in style.items() if k in ELEMENT_STYLE_KEYS[e.kind]})
    x, y = min(e.box.x for e in selected), min(e.box.y for e in selected)
    box = Box(x=x, y=y, width=max(e.box.x + e.box.width for e in selected) - x,
              height=max(e.box.y + e.box.height for e in selected) - y)
    index = min(slide.elements.index(e) for e in selected)
    slide.elements = [e for e in slide.elements if e.id not in op.ids]
    slide.elements.insert(index, Element(id=allocate(deck, "E"), name="组合", kind="group", box=box, children=selected))


def _ungroup(deck, op):
    owner, e = locate(deck, op.target, op.slide_id)
    if e.kind != "group":
        raise ValueError("目标不是组合")
    parent = _parent(owner.elements, e.id)
    index = parent.index(e)
    parent[index:index + 1] = e.children


def _rename(deck, op):
    deck.name = op.changes.get("name", "")


HANDLERS = {
    "update_element": _update_element, "add_element": _add_element, "delete_element": _delete_element,
    "move_element": _move_element, "add_slide": _add_slide, "delete_slide": _delete_slide,
    "duplicate_slide": _duplicate_slide, "move_slide": _move_slide, "update_slide": _update_slide,
    "master_style": _master_style, "layout_style": _layout_style, "theme": _theme,
    "reset_style": _reset_style, "group": _group, "ungroup": _ungroup, "rename": _rename,
}


def apply(deck, operations):
    if not 1 <= len(operations) <= 100:
        raise ValueError("每组操作需包含 1–100 项修改")
    candidate = deck.model_copy(deep=True)
    targets = []
    for raw in operations:
        op = Operation.model_validate(raw)
        HANDLERS[op.action](candidate, op)
        targets.extend(op.ids or ([op.target] if op.target else []))
    candidate.last_targets = list(dict.fromkeys(targets))[-10:]
    return Deck.model_validate(candidate.model_dump())
