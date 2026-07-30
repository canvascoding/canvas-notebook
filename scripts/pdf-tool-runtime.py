#!/usr/bin/env python3
"""Canvas PDF tool runtime.

This process receives only validated local paths from the Node tool layer.
It never resolves workspace paths or handles permissions itself.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
from pathlib import Path
from typing import Any


MAX_OUTPUTS = 50
MAX_PAGES_PER_OUTPUT = 2_000
LIST_BULLETS = ("\u2022", "\u25e6", "\u25aa", "\u25ab", "\u2013", "\u2014")


def fail(message: str) -> None:
    raise RuntimeError(message)


def json_dump(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pdf_dependencies() -> tuple[Any, Any, Any]:
    try:
        import pdfplumber
        from pypdf import PdfReader, PdfWriter
    except ImportError as error:
        fail(
            "PDF runtime dependency missing. The Canvas runtime requires "
            "pdfplumber and pypdf from requirements/runtime-python.txt. "
            f"Import error: {error}"
        )
    return pdfplumber, PdfReader, PdfWriter


def clean_text(value: Any) -> str:
    text = "" if value is None else str(value)
    return re.sub(r"\s+", " ", text.replace("\x00", "")).strip()


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def markdown_cell(value: Any) -> str:
    text = clean_text(value)
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", "<br>")


def markdown_table(rows: list[list[Any]]) -> str:
    normalized = [[markdown_cell(cell) for cell in row] for row in rows]
    normalized = [row for row in normalized if any(cell for cell in row)]
    if not normalized:
        return ""
    width = max(len(row) for row in normalized)
    padded = [row + [""] * (width - len(row)) for row in normalized]
    header = padded[0]
    body = padded[1:]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(lines)


def word_style(word: dict[str, Any]) -> tuple[bool, bool]:
    font_name = str(word.get("fontname") or "").lower()
    bold = any(token in font_name for token in ("bold", "black", "heavy", "semibold", "demi"))
    italic = any(token in font_name for token in ("italic", "oblique", "slanted"))
    return bold, italic


def escape_inline(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("*", "\\*")
        .replace("_", "\\_")
        .replace("`", "\\`")
    )


def styled_text(text: str, bold: bool, italic: bool) -> str:
    escaped = escape_inline(text)
    if bold and italic:
        return f"***{escaped}***"
    if bold:
        return f"**{escaped}**"
    if italic:
        return f"*{escaped}*"
    return escaped


def punctuation_needs_no_leading_space(text: str) -> bool:
    return bool(re.match(r"^[,.;:!?%)\]}]", text))


def previous_needs_no_trailing_space(text: str) -> bool:
    return bool(re.search(r"[(\[{/$]$", text))


def render_line_words(words: list[dict[str, Any]]) -> tuple[str, str]:
    plain_parts: list[str] = []
    markdown_parts: list[str] = []
    previous_text = ""
    current_style: tuple[bool, bool] | None = None
    current_run: list[str] = []

    def flush_run() -> None:
        nonlocal current_run
        if not current_run or current_style is None:
            return
        markdown_parts.append(styled_text("".join(current_run), *current_style))
        current_run = []

    for word in words:
        text = clean_text(word.get("text"))
        if not text:
            continue
        separator = ""
        if previous_text and not punctuation_needs_no_leading_space(text) and not previous_needs_no_trailing_space(previous_text):
            separator = " "
        plain_parts.append(separator + text)

        style = word_style(word)
        if current_style is None:
            current_style = style
        if style != current_style:
            flush_run()
            if separator:
                markdown_parts.append(separator)
            current_style = style
        elif current_run:
            current_run.append(separator)
        current_run.append(text)
        previous_text = text

    flush_run()
    return "".join(plain_parts).strip(), "".join(markdown_parts).strip()


def group_words_into_lines(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    ordered = sorted(words, key=lambda word: (float(word.get("top") or 0), float(word.get("x0") or 0)))
    lines: list[list[dict[str, Any]]] = []
    line_tops: list[float] = []
    for word in ordered:
        top = float(word.get("top") or 0)
        size = float(word.get("size") or 10)
        tolerance = max(2.0, min(5.0, size * 0.3))
        target = None
        for index in range(len(lines) - 1, max(-1, len(lines) - 5), -1):
            if abs(line_tops[index] - top) <= tolerance:
                target = index
                break
        if target is None:
            lines.append([word])
            line_tops.append(top)
        else:
            lines[target].append(word)
    for line in lines:
        line.sort(key=lambda word: float(word.get("x0") or 0))
    return lines


def center_inside_bbox(word: dict[str, Any], bbox: tuple[float, float, float, float]) -> bool:
    center_x = (float(word.get("x0") or 0) + float(word.get("x1") or 0)) / 2
    center_y = (float(word.get("top") or 0) + float(word.get("bottom") or 0)) / 2
    x0, top, x1, bottom = bbox
    return x0 <= center_x <= x1 and top <= center_y <= bottom


def table_detection_page(page: Any) -> Any:
    """Ignore large filled backgrounds that pdfplumber otherwise treats as table borders."""

    def keep_object(obj: dict[str, Any]) -> bool:
        if obj.get("object_type") != "rect":
            return True
        width = float(obj.get("width") or 0)
        height = float(obj.get("height") or 0)
        is_large_background = width >= float(page.width) * 0.75 and height >= 10
        return not is_large_background

    return page.filter(keep_object)


def classify_line(
    words: list[dict[str, Any]],
    body_size: float,
    base_x0: float,
) -> dict[str, Any] | None:
    plain, markdown = render_line_words(words)
    if not plain:
        return None
    sizes = [float(word.get("size") or body_size) for word in words]
    median_size = statistics.median(sizes) if sizes else body_size
    bold_ratio = sum(1 for word in words if word_style(word)[0]) / max(1, len(words))
    top = min(float(word.get("top") or 0) for word in words)
    bottom = max(float(word.get("bottom") or top + median_size) for word in words)
    x0 = min(float(word.get("x0") or 0) for word in words)

    kind = "paragraph"
    rendered = markdown
    stripped = plain.lstrip()
    if stripped.startswith(LIST_BULLETS) or stripped.startswith("- "):
        kind = "list"
        item = stripped[1:].strip()
        rendered = f"- {escape_inline(item)}"
    elif re.match(r"^\(?\d{1,3}[.)]\s+", stripped):
        kind = "list"
        rendered = re.sub(r"^\(?(\d{1,3})[.)]\s+", r"\1. ", stripped)
    elif median_size >= body_size * 1.55:
        kind = "heading"
        rendered = f"# {markdown}"
    elif median_size >= body_size * 1.3:
        kind = "heading"
        rendered = f"## {markdown}"
    elif median_size >= body_size * 1.14 and bold_ratio >= 0.5:
        kind = "heading"
        rendered = f"### {markdown}"
    elif x0 >= base_x0 + max(12.0, body_size * 1.5):
        kind = "list"
        rendered = f"- {markdown}"

    return {
        "type": kind,
        "top": top,
        "bottom": bottom,
        "x0": x0,
        "size": median_size,
        "plain": plain,
        "markdown": rendered,
    }


def join_paragraph_text(previous: str, current: str) -> str:
    if previous.endswith("-") and current and current[0].islower():
        return previous[:-1] + current
    return previous + " " + current


def render_page_markdown(
    page_number: int,
    page_data: dict[str, Any],
    body_size: float,
) -> tuple[str, list[str]]:
    warnings: list[str] = []
    words = page_data["words"]
    tables = page_data["tables"]
    table_bboxes = [table["bbox"] for table in tables]
    text_words = [
        word
        for word in words
        if not any(center_inside_bbox(word, bbox) for bbox in table_bboxes)
    ]
    base_x0 = min((float(word.get("x0") or 0) for word in text_words), default=0.0)
    elements: list[dict[str, Any]] = []
    for line_words in group_words_into_lines(text_words):
        line = classify_line(line_words, body_size, base_x0)
        if line:
            elements.append(line)
    for table in tables:
        rendered = markdown_table(table["rows"])
        if rendered:
            elements.append({
                "type": "table",
                "top": table["bbox"][1],
                "bottom": table["bbox"][3],
                "x0": table["bbox"][0],
                "size": body_size,
                "plain": "",
                "markdown": rendered,
            })

    elements.sort(key=lambda element: (element["top"], element["x0"]))
    blocks: list[str] = [f"<!-- page: {page_number} -->"]
    paragraph: dict[str, Any] | None = None

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            blocks.append(paragraph["markdown"].strip())
            paragraph = None

    for element in elements:
        if element["type"] != "paragraph":
            flush_paragraph()
            blocks.append(element["markdown"])
            continue
        if paragraph is None:
            paragraph = dict(element)
            continue
        vertical_gap = element["top"] - paragraph["bottom"]
        same_column = abs(element["x0"] - paragraph["x0"]) <= max(12.0, body_size)
        close_line = vertical_gap <= max(body_size * 0.9, 8.0)
        if same_column and close_line:
            paragraph["markdown"] = join_paragraph_text(paragraph["markdown"], element["markdown"])
            paragraph["plain"] = join_paragraph_text(paragraph["plain"], element["plain"])
            paragraph["bottom"] = element["bottom"]
        else:
            flush_paragraph()
            paragraph = dict(element)
    flush_paragraph()

    if len(blocks) == 1:
        blocks.append("> [!warning] No extractable text was found on this page. OCR may be required.")
        warnings.append(f"page {page_number}: no extractable text")
    image_count = int(page_data.get("image_count") or 0)
    if image_count:
        warnings.append(f"page {page_number}: {image_count} embedded image(s) were not converted")
    return "\n\n".join(blocks), warnings


def convert_to_markdown(input_path: Path, output_path: Path, metadata_path: Path, source_label: str) -> None:
    pdfplumber, _, _ = pdf_dependencies()
    pages: list[dict[str, Any]] = []
    all_sizes: list[float] = []
    warnings: list[str] = []
    title = input_path.stem
    with pdfplumber.open(str(input_path)) as pdf:
        metadata_title = clean_text((pdf.metadata or {}).get("Title"))
        if metadata_title:
            title = metadata_title
        for page_number, source_page in enumerate(pdf.pages, start=1):
            page = source_page.dedupe_chars()
            try:
                words = page.extract_words(
                    extra_attrs=["fontname", "size"],
                    use_text_flow=False,
                    keep_blank_chars=False,
                )
            except Exception as error:
                warnings.append(f"page {page_number}: styled word extraction failed ({error})")
                words = []
            for word in words:
                size = float(word.get("size") or 0)
                text = clean_text(word.get("text"))
                all_sizes.extend([size] * max(1, min(len(text), 30)))

            tables: list[dict[str, Any]] = []
            try:
                for table in table_detection_page(page).find_tables():
                    rows = table.extract() or []
                    if rows:
                        tables.append({"bbox": tuple(float(value) for value in table.bbox), "rows": rows})
            except Exception as error:
                warnings.append(f"page {page_number}: table extraction failed ({error})")

            pages.append({
                "words": words,
                "tables": tables,
                "image_count": len(page.images or []),
            })
    body_size = statistics.median(all_sizes) if all_sizes else 11.0
    if not math.isfinite(body_size) or body_size <= 0:
        body_size = 11.0

    page_markdown: list[str] = []
    for page_number, page_data in enumerate(pages, start=1):
        rendered, page_warnings = render_page_markdown(page_number, page_data, body_size)
        page_markdown.append(rendered)
        warnings.extend(page_warnings)

    frontmatter = "\n".join([
        "---",
        f"title: {yaml_string(title)}",
        f"source: {yaml_string(source_label)}",
        'source_type: "pdf"',
        f"page_count: {len(pages)}",
        'conversion_mode: "layout-aware-native"',
        "---",
    ])
    markdown = frontmatter + "\n\n" + "\n\n".join(page_markdown).strip() + "\n"
    output_path.write_text(markdown, encoding="utf-8")
    json_dump(metadata_path, {
        "pages": len(pages),
        "title": title,
        "bodyFontSize": round(body_size, 2),
        "warnings": warnings,
        "markdownBytes": len(markdown.encode("utf-8")),
    })


def validated_page_numbers(value: Any, page_count: int) -> list[int]:
    if not isinstance(value, list) or not value:
        fail("Each PDF output requires a non-empty pages array.")
    if len(value) > MAX_PAGES_PER_OUTPUT:
        fail(f"Each PDF output is limited to {MAX_PAGES_PER_OUTPUT} selected pages.")
    pages: list[int] = []
    for raw_page in value:
        if isinstance(raw_page, bool) or not isinstance(raw_page, int):
            fail("PDF page numbers must be integers.")
        if raw_page < 1 or raw_page > page_count:
            fail(f"PDF page {raw_page} is outside the valid range 1-{page_count}.")
        pages.append(raw_page)
    return pages


def validated_rotations(value: Any, page_count: int) -> dict[int, int]:
    if value is None:
        return {}
    if not isinstance(value, list):
        fail("rotations must be an array.")
    rotations: dict[int, int] = {}
    for entry in value:
        if not isinstance(entry, dict):
            fail("Each rotation must be an object.")
        degrees = entry.get("degrees")
        if degrees not in (90, 180, 270):
            fail("Rotation degrees must be 90, 180, or 270.")
        for page in validated_page_numbers(entry.get("pages"), page_count):
            rotations[page] = degrees
    return rotations


def transform_pdf(input_path: Path, request_path: Path, metadata_path: Path) -> None:
    _, PdfReader, PdfWriter = pdf_dependencies()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    outputs = request.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        fail("PDF transform request requires at least one output.")
    if len(outputs) > MAX_OUTPUTS:
        fail(f"PDF transform request is limited to {MAX_OUTPUTS} outputs.")

    reader = PdfReader(str(input_path), strict=False)
    if reader.is_encrypted:
        fail("Encrypted PDFs are not supported by the Canvas PDF tool.")
    page_count = len(reader.pages)
    written: list[dict[str, Any]] = []
    for output in outputs:
        if not isinstance(output, dict):
            fail("Each PDF transform output must be an object.")
        output_path = Path(str(output.get("path") or ""))
        if not output_path.is_absolute():
            fail("PDF runtime output paths must be absolute temporary paths.")
        pages = validated_page_numbers(output.get("pages"), page_count)
        rotations = validated_rotations(output.get("rotations"), page_count)
        writer = PdfWriter()
        for page_number in pages:
            written_page = writer.add_page(reader.pages[page_number - 1])
            degrees = rotations.get(page_number)
            if degrees:
                written_page.rotate(degrees)
        with output_path.open("wb") as stream:
            writer.write(stream)
        written.append({
            "path": str(output_path),
            "pages": pages,
            "pageCount": len(pages),
            "bytes": output_path.stat().st_size,
        })
    json_dump(metadata_path, {"sourcePageCount": page_count, "outputs": written})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Canvas PDF tool runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)

    convert = subparsers.add_parser("to-markdown")
    convert.add_argument("--input", required=True)
    convert.add_argument("--output", required=True)
    convert.add_argument("--metadata", required=True)
    convert.add_argument("--source-label", required=True)

    transform = subparsers.add_parser("transform")
    transform.add_argument("--input", required=True)
    transform.add_argument("--request", required=True)
    transform.add_argument("--metadata", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        fail("Input PDF does not exist or is not a file.")
    if input_path.suffix.lower() != ".pdf":
        fail("Input file must have a .pdf extension.")

    if args.command == "to-markdown":
        convert_to_markdown(
            input_path,
            Path(args.output).resolve(),
            Path(args.metadata).resolve(),
            args.source_label,
        )
        return
    if args.command == "transform":
        transform_pdf(
            input_path,
            Path(args.request).resolve(),
            Path(args.metadata).resolve(),
        )
        return
    fail("Unsupported PDF runtime command.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PDF tool runtime error: {error}", file=sys.stderr)
        sys.exit(1)
