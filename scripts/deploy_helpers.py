#!/usr/bin/env python3
"""Helper utilities for deploy.sh to keep the shell script simple."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import tomllib


def _extract_json(blob: str) -> list[dict] | dict:
    """Best-effort extraction of JSON payload from Wrangler's noisy output."""
    blob = blob.strip()
    if not blob:
        raise ValueError("Empty JSON blob")

    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        pass

    cleaned_lines = []
    noisy_prefixes = (
        "INFO ",
        "\u26c5\ufe0f",
        "\U0001f300",
        "\u2718",
        "\u2500" * 19,
        "Resource location:",
    )
    for line in blob.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if any(stripped.startswith(prefix) for prefix in noisy_prefixes):
            continue
        cleaned_lines.append(line)
    cleaned_blob = "\n".join(cleaned_lines).strip()
    if cleaned_blob:
        try:
            return json.loads(cleaned_blob)
        except json.JSONDecodeError:
            pass

    for opener, closer in (("[", "]"), ("{", "}")):
        start = blob.find(opener)
        end = blob.rfind(closer)
        if start == -1 or end == -1 or end <= start:
            continue
        segment = blob[start : end + 1]
        try:
            return json.loads(segment)
        except json.JSONDecodeError:
            continue
    raise ValueError("Unable to parse JSON payload")


def cmd_wrangler_toml(path: Path) -> int:
    data = tomllib.loads(path.read_text())
    for entry in data.get("kv_namespaces") or []:
        if entry.get("binding") == "STATE":
            namespace_id = entry.get("id")
            if namespace_id and not namespace_id.strip().startswith("${"):
                print(namespace_id.strip())
            return 0
    return 1


def cmd_namespace_list(title: str, stdin_blob: str) -> int:
    try:
        payload = _extract_json(stdin_blob)
    except ValueError:
        return 1

    entries = payload if isinstance(payload, list) else payload.get("result", [])
    for entry in entries:
        if entry.get("title") == title:
            namespace_id = entry.get("id")
            if namespace_id:
                print(namespace_id)
                return 0
    return 1


def cmd_namespace_create(stdin_blob: str) -> int:
    for line in stdin_blob.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        result = payload.get("result") or {}
        namespace_id = result.get("id")
        if namespace_id:
            print(namespace_id)
            return 0
    return 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="deploy-helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    wrangler_parser = subparsers.add_parser("wrangler-toml", help="extract namespace id from wrangler.toml")
    wrangler_parser.add_argument("path", type=Path)

    list_parser = subparsers.add_parser("namespace-list", help="extract namespace id from wrangler namespace list output")
    list_parser.add_argument("title")

    subparsers.add_parser("namespace-create", help="extract namespace id from wrangler namespace create output")

    args = parser.parse_args(argv)
    if args.command == "wrangler-toml":
        return cmd_wrangler_toml(args.path)
    if args.command == "namespace-list":
        blob = sys.stdin.read()
        return cmd_namespace_list(args.title, blob)
    if args.command == "namespace-create":
        blob = sys.stdin.read()
        return cmd_namespace_create(blob)
    parser.error("Unknown subcommand")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
