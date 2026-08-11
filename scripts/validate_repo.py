#!/usr/bin/env python3
"""Fast, dependency-free repository checks used locally and in GitHub Actions."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    ".gitignore",
    "LICENSE",
    "README.md",
    "config/SM2_Automation.cfg",
    "config/SM2_Control.cfg",
    "config/SM2_Hardware_Control.cfg",
    "config/SM2_LED_Effects.cfg",
    "config/SM2_Local_Hardware.cfg.example",
    "config/SM2_Material_Profiles.cfg",
    "config/SM2_Variables.cfg",
    "dashboard/app.js",
    "dashboard/index.html",
    "dashboard/styles.css",
    "scripts/install.sh",
    "scripts/uninstall.sh",
}
TEXT_SUFFIXES = {".cfg", ".css", ".html", ".js", ".json", ".md", ".py", ".sh", ".txt", ".yml", ".yaml"}
ALLOWED_EXTERNAL_COMMANDS = {
    "CALIBRATE_SGP40",
    "QUERY_SGP40",
    "RESET_SGP40",
}


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def text_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and ".git" not in path.parts
        and path.suffix.lower() in TEXT_SUFFIXES
    )


def validate_required(errors: list[str]) -> None:
    for relative in sorted(REQUIRED):
        if not (ROOT / relative).is_file():
            fail(errors, f"missing required file: {relative}")


def validate_text(errors: list[str], files: list[Path]) -> None:
    private_patterns = {
        "absolute home path": re.compile(r"/home/(?!USER\b)[A-Za-z0-9_.-]+/"),
        "real USB MCU serial": re.compile(r"/dev/serial/by-id/(?:usb|pci|platform)-[A-Za-z0-9_.:+-]+"),
        "real CAN UUID": re.compile(r"\bcanbus_uuid:\s*(?!REPLACE_)[0-9a-fA-F]{8,}\b"),
    }
    allowed_home_files = {ROOT / "scripts/install.sh", ROOT / "scripts/uninstall.sh"}
    for path in files:
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            fail(errors, f"not UTF-8: {path.relative_to(ROOT)}")
            continue
        if "\t" in content:
            fail(errors, f"tab character: {path.relative_to(ROOT)}")
        for line_number, line in enumerate(content.splitlines(), 1):
            if line.rstrip() != line:
                fail(errors, f"trailing whitespace: {path.relative_to(ROOT)}:{line_number}")
        for label, pattern in private_patterns.items():
            if label == "absolute home path" and path in allowed_home_files:
                continue
            if pattern.search(content):
                fail(errors, f"{label}: {path.relative_to(ROOT)}")


def validate_configs(errors: list[str]) -> None:
    config_files = sorted((ROOT / "config").glob("*.cfg"))
    config_files.append(ROOT / "config/SM2_Local_Hardware.cfg.example")
    section_pattern = re.compile(r"^\s*\[([^]]+)\]\s*$", re.MULTILINE)
    defined_commands: set[str] = set()
    delayed_ids: set[str] = set()
    defined_sections: dict[str, Path] = {}
    all_content = ""

    for path in config_files:
        content = path.read_text(encoding="utf-8")
        all_content += "\n" + content
        stack: list[tuple[str, int]] = []
        for match in re.finditer(r"{%\s*(if|elif|else|endif|for|endfor)\b.*?%}", content, re.DOTALL):
            token = match.group(1)
            line = content.count("\n", 0, match.start()) + 1
            if token in {"if", "for"}:
                stack.append((token, line))
            elif token in {"elif", "else"}:
                if not stack or stack[-1][0] != "if":
                    fail(errors, f"Jinja {token} without matching if: {path.relative_to(ROOT)}:{line}")
            else:
                expected = "if" if token == "endif" else "for"
                if not stack or stack[-1][0] != expected:
                    fail(errors, f"Jinja {token} mismatch: {path.relative_to(ROOT)}:{line}")
                else:
                    stack.pop()
        for token, line in stack:
            fail(errors, f"unclosed Jinja {token}: {path.relative_to(ROOT)}:{line}")
        for section in section_pattern.findall(content):
            normalized_section = section.strip().lower()
            if normalized_section in defined_sections:
                fail(
                    errors,
                    f"duplicate config section [{section}]: "
                    f"{defined_sections[normalized_section].relative_to(ROOT)} and {path.relative_to(ROOT)}",
                )
            else:
                defined_sections[normalized_section] = path
            kind, _, name = section.partition(" ")
            if kind == "gcode_macro" and name:
                defined_commands.add(name.upper())
            elif kind == "delayed_gcode" and name:
                delayed_ids.add(name.upper())

    custom_call = re.compile(
        r"^\s*(NEVERMORE_[A-Z0-9_]+|SM_[A-Z0-9_]+|VENT_[A-Z0-9_]+|"
        r"NM_PROFILE_[A-Z0-9_]+|SGP40_[A-Z0-9_]+)\b",
        re.MULTILINE,
    )
    for command in sorted(set(custom_call.findall(all_content))):
        if command not in defined_commands and command not in ALLOWED_EXTERNAL_COMMANDS:
            fail(errors, f"undefined custom G-code command: {command}")

    delayed_call = re.compile(r"UPDATE_DELAYED_GCODE\s+ID=([A-Z0-9_]+)", re.IGNORECASE)
    for delayed_id in sorted(set(value.upper() for value in delayed_call.findall(all_content))):
        if delayed_id not in delayed_ids:
            fail(errors, f"undefined delayed_gcode ID: {delayed_id}")

    object_reference = re.compile(r'printer\["([^"]+)"\]')
    for object_name in sorted(set(object_reference.findall(all_content))):
        if object_name.lower() not in defined_sections:
            fail(errors, f"undefined Klipper object reference: {object_name}")

    local_example = (ROOT / "config/SM2_Local_Hardware.cfg.example").read_text(encoding="utf-8")
    if "REPLACE_WITH_YOUR_PCB_SERIAL" not in local_example:
        fail(errors, "local hardware example must contain an obvious MCU placeholder")
    if "[gcode_macro SM2_SETTINGS]" not in local_example:
        fail(errors, "local hardware example must define SM2_SETTINGS")


def validate_dashboard(errors: list[str]) -> None:
    html = (ROOT / "dashboard/index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "dashboard/app.js").read_text(encoding="utf-8")
    html_ids = set(re.findall(r'\bid="([A-Za-z][A-Za-z0-9_-]*)"', html))
    if len(html_ids) != len(re.findall(r'\bid="([A-Za-z][A-Za-z0-9_-]*)"', html)):
        fail(errors, "dashboard contains duplicate HTML ids")
    declared = re.search(r"const els = Object\.fromEntries\(\s*\[(.*?)\]\.map", javascript, re.DOTALL)
    if not declared:
        fail(errors, "could not find dashboard element declaration")
        return
    referenced_ids = set(re.findall(r'"([A-Za-z][A-Za-z0-9_-]*)"', declared.group(1)))
    for missing in sorted(referenced_ids - html_ids):
        fail(errors, f"dashboard JavaScript references missing id: {missing}")


def validate_json(errors: list[str], files: list[Path]) -> None:
    for path in files:
        if path.suffix.lower() != ".json":
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            fail(errors, f"invalid JSON: {path.relative_to(ROOT)}:{exc.lineno}: {exc.msg}")


def main() -> int:
    errors: list[str] = []
    files = text_files()
    validate_required(errors)
    validate_text(errors, files)
    validate_configs(errors)
    validate_dashboard(errors)
    validate_json(errors, files)
    if errors:
        print("Repository validation failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print(f"Repository validation passed ({len(files)} text files checked).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
