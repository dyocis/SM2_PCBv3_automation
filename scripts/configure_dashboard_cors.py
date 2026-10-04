#!/usr/bin/env python3
"""Add or remove the installer-owned Moonraker dashboard CORS entry."""

from __future__ import annotations

import argparse
import os
import re
import stat
import tempfile
from pathlib import Path


BEGIN_MARKER = "# SM2_DASHBOARD_CORS_BEGIN"
END_MARKER = "# SM2_DASHBOARD_CORS_END"
SECTION_RE = re.compile(r"^\s*\[([^]]+)]\s*(?:#.*)?$")
OPTION_RE = re.compile(r"^[A-Za-z0-9_.-]+\s*:")


def _remove_managed_block(lines: list[str]) -> tuple[list[str], bool]:
    updated: list[str] = []
    inside = False
    changed = False
    for line in lines:
        stripped = line.strip()
        if stripped == BEGIN_MARKER:
            if inside:
                raise ValueError("nested dashboard CORS marker")
            inside = True
            changed = True
            continue
        if stripped == END_MARKER:
            if not inside:
                raise ValueError("dashboard CORS end marker has no beginning")
            inside = False
            continue
        if not inside:
            updated.append(line)
    if inside:
        raise ValueError("dashboard CORS marker has no end")
    return updated, changed


def _authorization_bounds(lines: list[str]) -> tuple[int, int] | None:
    start = None
    for index, line in enumerate(lines):
        match = SECTION_RE.match(line.rstrip("\n"))
        if not match:
            continue
        if start is not None:
            return start, index
        if match.group(1).strip().lower() == "authorization":
            start = index
    if start is not None:
        return start, len(lines)
    return None


def _same_origin(line: str, origin: str) -> bool:
    value = line.strip().split("#", 1)[0].strip().strip('"\'')
    return value.lower() == origin.lower()


def add_origin(content: str, origin: str) -> tuple[str, bool]:
    origin = origin.strip().rstrip("/")
    if not re.fullmatch(r"https?://[^\s/]+(?::[0-9]+)?", origin, re.IGNORECASE):
        raise ValueError(f"invalid dashboard origin: {origin}")

    lines, removed = _remove_managed_block(content.splitlines(keepends=True))
    bounds = _authorization_bounds(lines)
    if bounds and any(_same_origin(line, origin) for line in lines[bounds[0] + 1 : bounds[1]]):
        updated = "".join(lines)
        return updated, removed or updated != content

    block = [
        f"  {BEGIN_MARKER}\n",
        f"  {origin.lower()}\n",
        f"  {END_MARKER}\n",
    ]
    if bounds is None:
        if lines and lines[-1].strip():
            lines.append("\n")
        lines.extend(["[authorization]\n", "cors_domains:\n", *block])
    else:
        start, end = bounds
        cors_index = next(
            (
                index
                for index in range(start + 1, end)
                if re.match(r"^\s*cors_domains\s*:", lines[index], re.IGNORECASE)
            ),
            None,
        )
        if cors_index is not None:
            lines[cors_index + 1 : cors_index + 1] = block
        else:
            insertion = end
            while insertion > start + 1 and not lines[insertion - 1].strip():
                insertion -= 1
            prefix = [] if insertion == start + 1 else ["\n"]
            lines[insertion:insertion] = [*prefix, "cors_domains:\n", *block]

    updated = "".join(lines)
    return updated, updated != content


def remove_origin(content: str) -> tuple[str, bool]:
    lines, changed = _remove_managed_block(content.splitlines(keepends=True))
    return "".join(lines), changed


def update_file(path: Path, operation: str, origin: str | None = None) -> bool:
    content = path.read_text(encoding="utf-8")
    if operation == "add":
        if origin is None:
            raise ValueError("origin is required for add")
        updated, changed = add_origin(content, origin)
    else:
        updated, changed = remove_origin(content)
    if not changed:
        return False

    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".sm2-moonraker.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            temporary.write(updated)
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)
    add_parser = subparsers.add_parser("add")
    add_parser.add_argument("path", type=Path)
    add_parser.add_argument("origin")
    remove_parser = subparsers.add_parser("remove")
    remove_parser.add_argument("path", type=Path)
    arguments = parser.parse_args()

    changed = update_file(
        arguments.path,
        arguments.operation,
        getattr(arguments, "origin", None),
    )
    print("changed" if changed else "unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
