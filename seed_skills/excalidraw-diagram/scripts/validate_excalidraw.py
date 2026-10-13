#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
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
MAX_PORTABLE_BYTES = 50 * 1024 * 1024
MAX_REQUEST_BYTES = 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def is_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate_point(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and is_number(value[0])
        and is_number(value[1])
    )


def validate_file(path: Path) -> tuple[list[str], list[str]]:
    try:
        if path.stat().st_size > MAX_PORTABLE_BYTES:
            return ["Portable scene exceeds 50 MiB"], []
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        return [f"Cannot read portable scene JSON: {exc}"], []
    errors, warnings = validate_scene(data)
    if path.suffix.lower() != ".excalidraw":
        warnings.append("File extension should be .excalidraw")
    return errors, warnings


def is_integer(value: Any, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= MAX_SAFE_INTEGER


def validate_scene(data: Any) -> tuple[list[str], list[str]]:
    """Advisory validation only: never writes files or calls Canvas."""
    errors: list[str] = []
    warnings: list[str] = []

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

    files = data.get("files", {})
    if not isinstance(files, dict):
        errors.append("Root field files must be an object")
        files = {}

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
        if not isinstance(element_id, str) or not SAFE_ID.fullmatch(element_id):
            errors.append(f"{label}.id must match [A-Za-z0-9_-]{{1,128}}")
            element_id = label
        elif element_id in ids:
            errors.append(f"Duplicate element id: {element_id}")
        else:
            ids.add(element_id)

        element_type = element.get("type")
        if not isinstance(element_type, str) or element_type not in ALLOWED_ELEMENT_TYPES:
            errors.append(f"{label}.type is unsupported: {element_type!r}")
            continue

        if not is_integer(element.get("version"), 1):
            errors.append(f"{label}.version must be a positive safe integer")
        if not is_integer(element.get("versionNonce")):
            errors.append(f"{label}.versionNonce must be a non-negative safe integer")
        if not isinstance(element.get("isDeleted"), bool):
            errors.append(f"{label}.isDeleted must be boolean")

        if element_type == "image" and not element.get("isDeleted"):
            file_id = element.get("fileId")
            if file_id is None and element.get("status") == "pending":
                warnings.append(f"{label} is an unfinished pending image; prefer complete vector elements")
            elif not isinstance(file_id, str) or not SAFE_ID.fullmatch(file_id) or file_id not in files:
                errors.append(f"{label}.fileId references a missing image asset")

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
            if not is_integer(element.get("fontFamily")) or element.get("fontFamily") not in FONT_IDS:
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
                and all(isinstance(item, str) and SAFE_ID.fullmatch(item) for item in element[field])
            ):
                errors.append(f"{label}.{field} must be an array of valid element IDs")

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


def validate_operation(data: Any) -> tuple[list[str], list[str]]:
    """Validate an Edit request against its read scene in memory; no publication."""
    if not isinstance(data, dict) or set(data) != {"scene", "request"}:
        return ["Operation input must contain exactly scene and request"], []
    scene, request = data["scene"], data["request"]
    if not isinstance(scene, dict) or not isinstance(request, dict):
        return ["scene and request must be JSON objects"], []
    errors: list[str] = []
    allowed = {"workspaceId", "path", "documentId", "lifecycleGeneration", "observedSceneSequence", "actions", "idempotencyKey"}
    if set(request) - allowed:
        errors.append("Edit accepts only identity, observedSceneSequence, actions and idempotencyKey; no actor, assets, or whole-scene fields")
    if len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_REQUEST_BYTES:
        errors.append("Edit request exceeds 1 MiB")
    for field, maximum in (("documentId", 200), ("idempotencyKey", 500)):
        value = request.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            errors.append(f"request.{field} must contain 1–{maximum} characters")
    for field, minimum in (("lifecycleGeneration", 1), ("observedSceneSequence", 0)):
        if not is_integer(request.get(field), minimum):
            errors.append(f"request.{field} must be a safe integer >= {minimum}")
    for field in ("documentId", "lifecycleGeneration"):
        if scene.get(field) != request.get(field):
            errors.append(f"request.{field} differs from the read scene; Get the current scene again")
    if scene.get("sceneSequence") != request.get("observedSceneSequence"):
        errors.append("observedSceneSequence differs from the read scene; use the latest Get result")
    for field, maximum in (("workspaceId", 200), ("path", 1024)):
        if field in request:
            value = request[field]
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                errors.append(f"request.{field} must contain 1–{maximum} characters")
            elif value != scene.get(field):
                errors.append(f"request.{field} does not identify the read scene")
    elements, assets, actions = scene.get("elements"), scene.get("assets"), request.get("actions")
    if not isinstance(elements, list) or not all(isinstance(element, dict) and isinstance(element.get("id"), str) for element in elements):
        return errors + ["scene.elements must contain elements with string IDs"], []
    if not isinstance(assets, list) or not all(isinstance(asset, dict) and isinstance(asset.get("fileId"), str) for asset in assets):
        return errors + ["scene.assets must contain asset metadata with fileId"], []
    if not isinstance(actions, list) or not 1 <= len(actions) <= 500:
        return errors + ["request.actions must contain 1–500 actions"], []
    merged = {element["id"]: element.copy() for element in elements}
    if len(merged) != len(elements):
        errors.append("scene.elements contains duplicate IDs")
    targets: set[str] = set()
    for index, action in enumerate(actions):
        label = f"actions[{index}]"
        if not isinstance(action, dict) or action.get("type") not in ("create", "update", "delete"):
            errors.append(f"{label} must be a create, update or delete action")
            continue
        kind = action["type"]
        fields = {"type", "element"} if kind == "create" else {"type", "elementId", "expectedVersion", "expectedVersionNonce"}
        if kind == "update":
            fields.add("element")
        if set(action) != fields:
            errors.append(f"{label} has missing or unsupported action fields")
        element = action.get("element")
        target = element.get("id") if kind == "create" and isinstance(element, dict) else action.get("elementId")
        if not isinstance(target, str) or not SAFE_ID.fullmatch(target):
            errors.append(f"{label} has an invalid target ID")
            continue
        if target in targets:
            errors.append(f"{label} targets {target} more than once")
        targets.add(target)
        current = merged.get(target)
        if kind == "create":
            if current is not None:
                errors.append(f"{label} reuses existing or deleted ID {target}")
        else:
            if current is None or current.get("isDeleted"):
                errors.append(f"{label} targets a missing or deleted element; Get again")
            for expected, observed, minimum in (("expectedVersion", "version", 1), ("expectedVersionNonce", "versionNonce", 0)):
                if not is_integer(action.get(expected), minimum):
                    errors.append(f"{label}.{expected} must be a safe integer >= {minimum}")
                elif current is not None and action[expected] != current.get(observed):
                    errors.append(f"{label}.{expected} is stale; Get again and submit a new request/key")
        if kind == "delete":
            if current is not None:
                merged[target] = {**current, "isDeleted": True}
        elif not isinstance(element, dict) or element.get("id") != target:
            errors.append(f"{label}.element must be complete and use the target ID")
        else:
            if element.get("isDeleted") is True:
                errors.append(f"{label}.element must be live; use a delete action instead of isDeleted:true")
            merged[target] = element.copy()
    scene_errors, warnings = validate_scene({"type": "excalidraw", "version": 2, "source": "canvas-notebook",
                                            "elements": list(merged.values()), "appState": scene.get("appState", {}),
                                            "files": {asset["fileId"]: {} for asset in assets}})
    return errors + scene_errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only validation of Canvas Excalidraw scenes or element requests")
    parser.add_argument("path", type=Path, nargs="?", help="Read an existing portable file; never writes it")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--stdin", action="store_true", help="Read portable scene JSON from stdin")
    mode.add_argument("--operation-stdin", action="store_true", help="Read {scene: Get result, request: Edit input} from stdin")
    args = parser.parse_args()
    if bool(args.path) == bool(args.stdin or args.operation_stdin):
        parser.error("Choose one existing path or one stdin mode")
    if args.path:
        errors, warnings = validate_file(args.path)
    else:
        try:
            raw = sys.stdin.buffer.read(MAX_PORTABLE_BYTES + 1)
            if len(raw) > MAX_PORTABLE_BYTES:
                raise ValueError("Validation input exceeds 50 MiB")
            data = json.loads(raw)
            errors, warnings = validate_operation(data) if args.operation_stdin else validate_scene(data)
        except (UnicodeError, ValueError) as exc:
            errors, warnings = [f"Invalid JSON input: {exc}"], []
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print("OK: advisory validation passed; Canvas must still authorize and apply the operation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
