#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


ALLOWED_ELEMENT_TYPES = {
    "arrow",
    "diamond",
    "ellipse",
    "embeddable",
    "frame",
    "freedraw",
    "image",
    "iframe",
    "line",
    "magicframe",
    "rectangle",
    "text",
}

FONT_IDS = {1, 2, 3, 5, 6, 7, 8, 9, 100, 1000}
REQUIRED_COMMON_FIELDS = {
    "id",
    "type",
    "x",
    "y",
    "width",
    "height",
    "angle",
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "strokeWidth",
    "strokeStyle",
    "roughness",
    "opacity",
    "seed",
    "version",
    "versionNonce",
    "isDeleted",
    "groupIds",
    "boundElements",
    "link",
    "locked",
}


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_point(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and is_number(value[0])
        and is_number(value[1])
    )


def validate_file(path: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if path.suffix.lower() != ".excalidraw":
        warnings.append("File extension should be .excalidraw")

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"Invalid JSON: {exc}"], warnings

    if not isinstance(data, dict):
        return ["Root must be a JSON object"], warnings

    if data.get("type") != "excalidraw":
        errors.append("Root field type must be 'excalidraw'")
    if data.get("version") != 2:
        warnings.append("Root field version should be 2")
    if data.get("source") != "canvas-notebook":
        warnings.append("Root field source should be 'canvas-notebook'")

    elements = data.get("elements")
    if not isinstance(elements, list):
        errors.append("Root field elements must be an array")
        elements = []
    elif not elements:
        warnings.append("elements is empty; this is valid, but requested diagrams should contain elements")

    app_state = data.get("appState")
    if not isinstance(app_state, dict):
        errors.append("Root field appState must be an object")
    elif not isinstance(app_state.get("viewBackgroundColor", "#ffffff"), str):
        errors.append("appState.viewBackgroundColor must be a string when present")

    if not isinstance(data.get("files", {}), dict):
        errors.append("Root field files must be an object")

    ids: set[str] = set()
    refs: list[tuple[str, str]] = []
    non_deleted_bounds: list[tuple[float, float, float, float]] = []

    for index, element in enumerate(elements):
        label = f"elements[{index}]"
        if not isinstance(element, dict):
            errors.append(f"{label} must be an object")
            continue

        missing = sorted(REQUIRED_COMMON_FIELDS - set(element))
        if missing:
            errors.append(f"{label} missing required fields: {', '.join(missing)}")

        element_id = element.get("id")
        if not isinstance(element_id, str) or not element_id:
            errors.append(f"{label}.id must be a non-empty string")
            element_id = label
        elif element_id in ids:
            errors.append(f"Duplicate element id: {element_id}")
        else:
            ids.add(element_id)

        element_type = element.get("type")
        if element_type not in ALLOWED_ELEMENT_TYPES:
            errors.append(f"{label}.type is unsupported: {element_type!r}")

        for field in ("x", "y", "width", "height", "angle", "strokeWidth", "roughness", "opacity"):
            if field in element and not is_number(element[field]):
                errors.append(f"{label}.{field} must be a finite number")

        if is_number(element.get("opacity")) and not 0 <= element["opacity"] <= 100:
            errors.append(f"{label}.opacity must be between 0 and 100")

        if element_type in {"rectangle", "ellipse", "diamond", "image", "iframe", "embeddable", "frame"}:
            if is_number(element.get("width")) and element["width"] <= 0:
                warnings.append(f"{label}.width should be positive")
            if is_number(element.get("height")) and element["height"] <= 0:
                warnings.append(f"{label}.height should be positive")

        if element_type == "text":
            for field in ("text", "originalText"):
                if not isinstance(element.get(field), str):
                    errors.append(f"{label}.{field} must be a string")
            if not is_number(element.get("fontSize")):
                errors.append(f"{label}.fontSize must be a finite number")
            if element.get("fontFamily") not in FONT_IDS:
                warnings.append(f"{label}.fontFamily should be a known Excalidraw font id")
            if not is_number(element.get("lineHeight")):
                errors.append(f"{label}.lineHeight must be a finite number")

            text = element.get("text")
            font_size = element.get("fontSize")
            width = element.get("width")
            if isinstance(text, str) and is_number(font_size) and is_number(width):
                longest_line = max((len(line) for line in text.splitlines()), default=0)
                estimated_width = longest_line * font_size * 0.45
                if width < estimated_width:
                    warnings.append(f"{label}.width may clip text '{text[:40]}'")

        if element_type in {"arrow", "line"}:
            points = element.get("points")
            if not isinstance(points, list) or len(points) < 2 or not all(validate_point(point) for point in points):
                errors.append(f"{label}.points must contain at least two [x, y] points")
            if element_type == "arrow" and "endArrowhead" not in element:
                errors.append(f"{label}.endArrowhead is required for arrows")

        for field in ("groupIds",):
            if field in element and not (
                isinstance(element[field], list)
                and all(isinstance(item, str) for item in element[field])
            ):
                errors.append(f"{label}.{field} must be an array of strings")

        for field in ("containerId", "frameId"):
            value = element.get(field)
            if value is not None:
                if not isinstance(value, str):
                    errors.append(f"{label}.{field} must be null or a string")
                else:
                    refs.append((f"{label}.{field}", value))

        bound_elements = element.get("boundElements")
        if bound_elements is not None:
            if not isinstance(bound_elements, list):
                errors.append(f"{label}.boundElements must be null or an array")
            else:
                for bound_index, bound in enumerate(bound_elements):
                    if not isinstance(bound, dict):
                        errors.append(f"{label}.boundElements[{bound_index}] must be an object")
                        continue
                    bound_id = bound.get("id")
                    if isinstance(bound_id, str):
                        refs.append((f"{label}.boundElements[{bound_index}].id", bound_id))
                    else:
                        errors.append(f"{label}.boundElements[{bound_index}].id must be a string")

        for binding_field in ("startBinding", "endBinding"):
            binding = element.get(binding_field)
            if binding is not None:
                if not isinstance(binding, dict):
                    errors.append(f"{label}.{binding_field} must be null or an object")
                elif isinstance(binding.get("elementId"), str):
                    refs.append((f"{label}.{binding_field}.elementId", binding["elementId"]))
                else:
                    errors.append(f"{label}.{binding_field}.elementId must be a string")

        if not element.get("isDeleted") and all(
            is_number(element.get(field)) for field in ("x", "y", "width", "height")
        ):
            x = float(element["x"])
            y = float(element["y"])
            width = abs(float(element["width"]))
            height = abs(float(element["height"]))
            non_deleted_bounds.append((x, y, x + width, y + height))

    for ref_label, ref_id in refs:
        if ref_id not in ids:
            errors.append(f"{ref_label} references missing element id {ref_id!r}")

    if non_deleted_bounds:
        min_x = min(bound[0] for bound in non_deleted_bounds)
        min_y = min(bound[1] for bound in non_deleted_bounds)
        max_x = max(bound[2] for bound in non_deleted_bounds)
        max_y = max(bound[3] for bound in non_deleted_bounds)
        if max_x - min_x > 20000 or max_y - min_y > 20000:
            warnings.append("Scene bounds are very large; Canvas Notebook may zoom out too far")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Canvas Notebook .excalidraw JSON")
    parser.add_argument("path", type=Path)
    args = parser.parse_args()

    if not args.path.exists():
        print(f"ERROR: file not found: {args.path}", file=sys.stderr)
        return 1

    errors, warnings = validate_file(args.path)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"OK: {args.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
