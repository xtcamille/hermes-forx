"""Build an installable package and a native-object demonstration in the workspace."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import zipfile
from pathlib import Path


def build(output):
    root = Path(__file__).resolve().parent
    repo_root = str(root.parents[1])
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    package = "forx_ppt_build"
    spec = importlib.util.spec_from_file_location(package, root / "__init__.py", submodule_search_locations=[str(root)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[package] = module
    spec.loader.exec_module(module)
    from forx_ppt_build.models import new_deck
    from forx_ppt_build.pptx_io import export_pptx
    from forx_ppt_build.preview import render
    from forx_ppt_build.storage import Store, encoded
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="forx-ppt-release-") as temp:
        token = set_hermes_home_override(temp)
        try:
            store = Store()
            deck = new_deck("ForX PPT 创作台示例", [
                {"title": "ForX PPT 对话创作", "layout_id": "L001", "bullets": ["稳定编号与精准修改", "母版联动与主题切换", "导出可继续编辑的 PPTX"]},
                {"title": "通过编号持续修改", "bullets": ["每个页面具有稳定的 S 编号。", "每个元素具有文稿内唯一的 E 编号。", "重排页面后，仍可引用原元素编号。", "母版修改保留本页明确设置的样式。"]},
                {"title": "原生表格与图表", "bullets": [], "elements": [
                    {"kind": "table", "name": "示例数据表", "box": {"x": .6, "y": 2, "width": 4.4, "height": 3.0}, "style": {"font_size": 18}, "rows": [["分类", "示例数值"], ["A", "20"], ["B", "35"], ["C", "28"]]},
                    {"kind": "chart", "name": "示例柱状图", "text": "示例数据，可编辑", "box": {"x": 5.6, "y": 1.9, "width": 7, "height": 3.9}, "categories": ["A", "B", "C"], "series": [{"name": "示例", "values": [20, 35, 28]}]},
                ]},
                {"title": "继续表达你的想法", "layout_id": "L005", "bullets": ["在创作台中选择对象，用自然语言继续编辑。"]},
            ])
            deck.master.elements[1].text = "ForX PPT 插件示例 · 数据仅作演示"
            store.create(deck, "release-demo", "release-demo")
            (output / "forx-ppt-demo.pptx").write_bytes(export_pptx(deck, store))
            (output / "forx-ppt-demo.forxppt").write_text(encoded(store.bundle(deck)), encoding="utf-8")
            (output / "forx-ppt-demo.svg").write_text(render(deck, deck.slides[2], numbers=True)["svg"], encoding="utf-8")
        finally:
            reset_hermes_home_override(token)
    runtime = [p for p in root.glob("*.py") if p.name != "build_release.py"] + [root / "plugin.yaml", root / "README.md"]
    for folder in ("dashboard", "desktop", "skills"):
        runtime += [p for p in (root / folder).rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    archive = output / "forx-ppt-0.1.0.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(runtime):
            bundle.write(path, "forx-ppt/" + path.relative_to(root).as_posix())
    print(json.dumps({"package": str(archive.resolve()), "demo": str((output / "forx-ppt-demo.pptx").resolve())}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "artifacts/forx-ppt")
    build(parser.parse_args().output)
