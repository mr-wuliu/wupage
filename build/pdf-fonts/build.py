"""Reproduce the small test-only PDF font fixture; never included in the extension."""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from urllib.request import urlopen

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
TEXT = "".join(chr(code) for code in range(32, 127)) + (
    "中文译文繁體𠮷日本語한국어РусскийΕλληνικα"
    "这是用于验证论文段落排版与保护规则的本地模拟译文参考献附录背景训练测试状态出血死亡风险肾功能衰竭临床工具特征预测"
)


def build(source: Path, output: Path) -> None:
    pin = json.loads((ROOT / "public/pdf-fonts/font-metadata.json").read_text(encoding="utf-8"))["font"]
    if source.exists():
        data = source.read_bytes()
    else:
        with urlopen(pin["source"], timeout=120) as response:
            data = response.read()
    if len(data) != pin["bytes"] or sha256(data).hexdigest() != pin["sha256"]:
        raise ValueError("Upstream font size or SHA-256 mismatch")
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(data)
    with TTFont(BytesIO(data), recalcTimestamp=False) as font:
        options = subset.Options()
        options.layout_features = ["*"]
        # Retain local/global subroutine calls, like the installed full font.
        # Flattening them hides export bugs in CFF font-dictionary selection.
        options.desubroutinize = False
        options.notdef_outline = True
        options.recalc_timestamp = False
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=TEXT)
        subsetter.subset(font)
        output.parent.mkdir(parents=True, exist_ok=True)
        font.save(output)
    result = output.read_bytes()
    print(f"{output}: {len(result)} bytes, SHA-256 {sha256(result).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".npm-cache/pdf-font-trial/NotoSansCJKsc-Regular.otf")
    parser.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/pdf-export-font.otf")
    args = parser.parse_args()
    build(args.source, args.output)
