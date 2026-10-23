"""Report actual changes after inheritance resolution, rather than model estimates."""
from .models import all_elements, effective, resolved_color, walk


def _scene(deck, slide):
    entries = {}
    for e in list(walk(deck.master.elements)) + list(walk(slide.elements)):
        style, box = effective(deck, slide, e)
        for key in ("color", "fill", "line"):
            style[key] = resolved_color(style[key], deck)
        entries[e.id] = {"content": e.model_dump(exclude={"style", "box", "children"}),
                         "box": box.model_dump(), "style": style,
                         "shape": e.shape or deck.theme["shape"] if e.kind == "shape" else None}
    return entries


def describe(before, after):
    old = {s.id: s for s in before.slides} if before else {}
    new = {s.id: s for s in after.slides}
    slides, elements = [], set()
    for sid in dict.fromkeys([*old, *new]):
        a = _scene(before, old[sid]) if sid in old else {}
        b = _scene(after, new[sid]) if sid in new else {}
        changed = {key for key in set(a) | set(b) if a.get(key) != b.get(key)}
        background_changed = sid not in old or sid not in new or resolved_color(old[sid].background or "$background", before) != resolved_color(new[sid].background or "$background", after)
        if changed or background_changed:
            slides.append(sid)
            elements.update(changed)
    return {"slides": slides, "elements": sorted(elements),
            "preserved_overrides": [e.id for e in all_elements(after) if e.style.model_dump(exclude_none=True)]}
