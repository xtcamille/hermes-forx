---
name: ppt
description: Create and edit native PPTX projects with stable object IDs.
version: 0.1.0
author: ForX
license: MIT
metadata:
  hermes:
    category: productivity
    tags: [pptx, presentations, desktop]
---

# PPT 创作台

## Prerequisites

Enable the `forx-ppt` plugin and install its declared Python dependencies in the host runtime. The desktop contribution is optional for CLI workflows. Use the `terminal` tool to run the existing `hermes ppt` CLI; the plugin adds no permanent model tool schema.

## Workflow

1. Use `hermes ppt list`, then `hermes ppt show --project ID` before editing. Use the returned revision, stable page IDs (`S001`) and document-wide element IDs (`E0003`). A page's current ordinal is not its identity.
2. To generate an initial draft, use `hermes ppt chat --prompt "生成一份 8 页的产品介绍，业务数据使用待补充占位"`. To create from supplied content without another model call, write a UTF-8 JSON file with `name`, `theme` and `slides` and call `hermes ppt create --input PATH`.
3. For precise edits, use `write_file` to create a JSON array of operations and call `hermes ppt edit --project ID --revision REV --input PATH --request-id KEY`. Reuse the same key for a retry of the same payload. Never reuse it for a different instruction.
4. Export with `hermes ppt export --project ID --revision REV --output /absolute/path/result.pptx`. Use a `.forxppt` output path for a portable project. Import with `hermes ppt import --input PATH`.

Example targeted operation:

```json
[{"action":"update_element","target":"E0003","slide_id":"S001","changes":{"text":"产品介绍","style":{"font_size":34}}}]
```

Shared styles use `master_style` with target `title` or `body`. A document theme uses `theme` with changes `{"preset":"technology"}` (`business`, `technology`, `minimal`). The default preserves local overrides. Only clear explicitly named style properties when the user asks to include local customizations.

For natural language follow-ups, `hermes ppt chat --project ID --revision REV --prompt "..."` uses the host model. The desktop page adds selection references and a live preview. Point users to **PPT 创作台** in the sidebar for visual selection.

## Guardrails

- Validate the target and scope. Master objects affect all inheriting pages. Clarify an ambiguous name or page/element mismatch; never choose an approximate object.
- Preserve content and chart data during theme changes. Missing business facts are placeholders, not invented evidence.
- Undo/redo require the current revision: `hermes ppt undo --project ID --revision REV`.
- The preview is a structured scene preview; disclose relevant font/layout differences. Arbitrary externally modified PPTX imports and Office/WPS live synchronization are outside this release.
- Image elements remain replaceable native images; text inside an image is not an editable text box.
