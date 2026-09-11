#!/usr/bin/env python3
"""THROWAWAY PROTOTYPE: read-only local server for the note-view study."""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
from collections import Counter
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


SKIP_DIRECTORIES = {".git", ".obsidian", "tools", "Шаблоны"}
WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]")


def clean_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def split_document(text: str) -> tuple[dict[str, object], str, list[str]]:
    metadata: dict[str, object] = {}
    originals: list[str] = []
    body = text

    if text.startswith("---\n"):
        closing = text.find("\n---\n", 4)
        if closing >= 0:
            frontmatter = text[4:closing]
            body = text[closing + 5 :]
            active_list = ""
            for line in frontmatter.splitlines():
                top_level = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
                if top_level:
                    key, value = top_level.groups()
                    active_list = key if not value else ""
                    if value:
                        metadata[key] = clean_scalar(value)
                    elif key != "originals":
                        metadata[key] = []
                    continue

                list_item = re.match(r"^\s+-\s+(.*)$", line)
                if list_item and active_list and active_list != "originals":
                    value = clean_scalar(list_item.group(1))
                    items = metadata.setdefault(active_list, [])
                    if isinstance(items, list):
                        items.append(value)

                original = re.match(r"^\s+-\s+path:\s*(.+)$", line)
                if original and active_list == "originals":
                    originals.append(clean_scalar(original.group(1)))

    fallback = metadata.get("original_path")
    if isinstance(fallback, str) and fallback and fallback not in originals:
        originals.insert(0, fallback)

    return metadata, body.strip(), originals


def title_for(path: Path, body: str) -> str:
    heading = re.search(r"^#\s+(.+?)\s*$", body, re.MULTILINE)
    return heading.group(1).strip() if heading else path.stem


class Vault:
    def __init__(self, root: Path):
        self.root = root.resolve(strict=True)

    def resolve(self, relative: str, suffixes: set[str] | None = None) -> Path:
        candidate = (self.root / unquote(relative)).resolve(strict=True)
        if not candidate.is_relative_to(self.root):
            raise ValueError("Path escapes the Knowledge Base")
        if suffixes and candidate.suffix.lower() not in suffixes:
            raise ValueError("Unsupported file type")
        return candidate

    def markdown_files(self) -> list[Path]:
        files: list[Path] = []
        for path in self.root.rglob("*.md"):
            relative = path.relative_to(self.root)
            if any(part in SKIP_DIRECTORIES or part.startswith(".") for part in relative.parts):
                continue
            files.append(path)
        return sorted(files, key=lambda item: item.as_posix().casefold())

    def read_summary(self, path: Path) -> dict[str, object]:
        text = path.read_text(encoding="utf-8", errors="replace")
        metadata, body, originals = split_document(text)
        relative = path.relative_to(self.root).as_posix()
        folder = relative.rsplit("/", 1)[0] if "/" in relative else "Корень"
        return {
            "path": relative,
            "folder": folder,
            "section": relative.split("/", 1)[0] if "/" in relative else "Корень",
            "title": title_for(path, body),
            "type": metadata.get("type", "note"),
            "privacy": metadata.get("privacy", "—"),
            "original_count": len(originals),
            "original_kind": Path(originals[0]).suffix.lower().lstrip(".") if originals else "",
            "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="minutes"),
        }

    def index(self) -> dict[str, object]:
        notes = [self.read_summary(path) for path in self.markdown_files()]
        sections = Counter(note["section"] for note in notes)

        def default_rank(note: dict[str, object]) -> tuple[int, int, int, str]:
            kind = str(note["original_kind"])
            preferred_image = kind in {"jpg", "jpeg", "png", "webp"}
            type_rank = {"place": 0, "photo": 1}.get(str(note["type"]), 2)
            return (0 if note["privacy"] == "standard" else 1, type_rank, 0 if preferred_image else 1, str(note["path"]))

        with_original = [note for note in notes if note["original_count"]]
        default = min(with_original or notes, key=default_rank) if notes else None
        return {
            "notes": notes,
            "sections": [{"name": name, "count": count} for name, count in sorted(sections.items())],
            "default_note": default["path"] if default else None,
            "stats": {
                "notes": len(notes),
                "with_original": len(with_original),
                "original_formats": dict(Counter(note["original_kind"] for note in with_original)),
            },
        }

    def note(self, relative: str) -> dict[str, object]:
        path = self.resolve(relative, {".md"})
        text = path.read_text(encoding="utf-8", errors="replace")
        metadata, body, originals = split_document(text)
        summary = self.read_summary(path)

        original_items = []
        for original in originals:
            try:
                original_path = self.resolve(original)
            except (FileNotFoundError, ValueError):
                original_items.append({"path": original, "missing": True})
                continue
            original_items.append(
                {
                    "path": original,
                    "name": original_path.name,
                    "extension": original_path.suffix.lower().lstrip("."),
                    "mime": mimetypes.guess_type(original_path.name)[0] or "application/octet-stream",
                    "size": original_path.stat().st_size,
                    "url": f"/api/asset?path={quote(original, safe='')}",
                    "missing": False,
                }
            )

        target_names = {path.stem, path.relative_to(self.root).with_suffix("").as_posix()}
        backlinks = []
        for candidate in self.markdown_files():
            if candidate == path:
                continue
            candidate_text = candidate.read_text(encoding="utf-8", errors="replace")
            for match in WIKILINK.finditer(candidate_text):
                if match.group(1).strip() not in target_names:
                    continue
                _, candidate_body, _ = split_document(candidate_text)
                start = max(0, match.start() - 70)
                end = min(len(candidate_text), match.end() + 90)
                snippet = re.sub(r"\s+", " ", candidate_text[start:end]).strip()
                backlinks.append(
                    {
                        "path": candidate.relative_to(self.root).as_posix(),
                        "title": title_for(candidate, candidate_body),
                        "snippet": snippet,
                    }
                )
                break

        links = []
        for target, label in WIKILINK.findall(body):
            links.append({"target": target.strip(), "label": (label or Path(target).name).strip()})

        return {
            **summary,
            "body": body,
            "metadata": metadata,
            "originals": original_items,
            "backlinks": backlinks,
            "links": links,
            "word_count": len(re.findall(r"\w+", body, re.UNICODE)),
        }


class PrototypeHandler(BaseHTTPRequestHandler):
    server_version = "IndexaryPrototype/1"

    @property
    def vault(self) -> Vault:
        return self.server.vault  # type: ignore[attr-defined]

    @property
    def static_root(self) -> Path:
        return self.server.static_root  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: object) -> None:
        # Avoid writing personal Knowledge Base paths to routine logs.
        return

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_path(self, path: Path, content_type: str | None = None) -> None:
        total = path.stat().st_size
        start, end = 0, total - 1
        status = HTTPStatus.OK
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if match:
                if match.group(1):
                    start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), total - 1)
                status = HTTPStatus.PARTIAL_CONTENT

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/index":
                self.send_json(self.vault.index())
                return
            if parsed.path == "/api/note":
                relative = query.get("path", [""])[0]
                self.send_json(self.vault.note(relative))
                return
            if parsed.path == "/api/asset":
                relative = query.get("path", [""])[0]
                self.send_path(self.vault.resolve(relative))
                return
            if parsed.path in {"/", "/index.html"}:
                self.send_path(self.static_root / "index.html", "text/html; charset=utf-8")
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (FileNotFoundError, IsADirectoryError, ValueError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except Exception as error:  # Prototype-friendly visible failure.
            self.send_json({"error": type(error).__name__}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Indexary note-view prototype")
    parser.add_argument("--vault", type=Path, default=Path.home() / "vault")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    vault = Vault(args.vault)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), PrototypeHandler)
    server.vault = vault  # type: ignore[attr-defined]
    server.static_root = Path(__file__).parent  # type: ignore[attr-defined]
    print(f"Indexary note-view prototype: http://127.0.0.1:{args.port}/?variant=B", flush=True)
    print("Knowledge Base is mounted read-only for this process.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
