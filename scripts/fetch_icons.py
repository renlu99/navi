import base64
import hashlib
from html.parser import HTMLParser
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
ICON_MANIFEST_FILE = ROOT / "icon-manifest.json"
ICON_DIR = ROOT / "icons"
MAX_BYTES = 512 * 1024
USER_AGENT = "navi-icon-fetcher/1.0 (+https://github.com/)"


def github_json(url, token):
    request = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        },
    )
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def read_private_shortcuts():
    token = os.environ.get("NAVI_DATA_TOKEN", "").strip()
    repository = os.environ.get("NAVI_DATA_REPO", "renlu99/navi-data").strip()
    branch = os.environ.get("NAVI_DATA_BRANCH", "main").strip()
    path = os.environ.get("NAVI_DATA_PATH", "shortcuts.json").strip()
    if not token:
        raise ValueError("缺少 Actions secret NAVI_DATA_TOKEN")
    if "/" not in repository or not path:
        raise ValueError("NAVI_DATA_REPO 或 NAVI_DATA_PATH 配置不正确")

    owner, repo = repository.split("/", 1)
    api_url = (
        f"https://api.github.com/repos/{quote(owner)}/{quote(repo)}"
        f"/contents/{quote(path, safe='/')}?ref={quote(branch)}"
    )
    payload = github_json(api_url, token)
    if payload.get("type") != "file" or not payload.get("content"):
        raise ValueError("navi-data 中找不到 shortcuts.json")
    raw = base64.b64decode("".join(payload["content"].split())).decode("utf-8")
    document = json.loads(raw)
    items = document if isinstance(document, list) else document.get("items", [])
    if not isinstance(items, list):
        raise ValueError("navi-data/shortcuts.json 的 items 必须是数组")
    return items


def icon_candidates(url):
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return []
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return [
        f"{origin}/favicon.ico",
        f"{origin}/favicon.png",
        f"{origin}/favicon.svg",
        f"{origin}/apple-touch-icon.png",
    ]


class IconLinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.icon_links = []
        self.manifest_links = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "link":
            return
        values = {key.lower(): value for key, value in attrs if value}
        href = values.get("href")
        rels = set((values.get("rel") or "").lower().split())
        if not href:
            return
        if "manifest" in rels:
            self.manifest_links.append(href)
        if {"icon", "apple-touch-icon", "mask-icon"} & rels:
            self.icon_links.append(href)


def page_icon_candidates(url):
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            html = response.read(1024 * 1024 + 1)
            if len(html) > 1024 * 1024:
                return []
            base_url = response.geturl()
            content_type = response.headers.get_content_type().lower()
        if "html" not in content_type and b"<html" not in html[:512].lower():
            return []
        parser = IconLinkParser()
        parser.feed(html.decode("utf-8", errors="ignore"))
        candidates = [urljoin(base_url, href) for href in parser.icon_links]
        for href in parser.manifest_links:
            manifest_url = urljoin(base_url, href)
            try:
                manifest_request = Request(
                    manifest_url,
                    headers={"Accept": "application/manifest+json,application/json,*/*;q=0.5", "User-Agent": USER_AGENT},
                )
                with urlopen(manifest_request, timeout=15) as manifest_response:
                    manifest = json.loads(manifest_response.read(256 * 1024).decode("utf-8"))
                for icon in manifest.get("icons", []):
                    if isinstance(icon, dict) and icon.get("src"):
                        candidates.append(urljoin(manifest_url, icon["src"]))
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
                continue
        return [candidate for candidate in candidates if urlparse(candidate).scheme in {"http", "https"}]
    except (HTTPError, URLError, TimeoutError, ValueError):
        return []


def looks_like_image(data, content_type):
    sample = data[:512].lstrip().lower()
    if b"<html" in sample or b"<!doctype" in sample:
        return False
    if data.startswith((b"\x00\x00\x01\x00", b"\x00\x00\x02\x00")):
        return True
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if data.startswith((b"\xff\xd8\xff", b"GIF87a", b"GIF89a")):
        return True
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    if content_type == "image/svg+xml" or b"<svg" in sample:
        return b"<script" not in sample
    return content_type.startswith("image/")


def extension_for(url, content_type, data):
    content_type = content_type.split(";", 1)[0].lower()
    types = {
        "image/x-icon": "ico",
        "image/vnd.microsoft.icon": "ico",
        "image/png": "png",
        "image/svg+xml": "svg",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
    }
    if content_type in types:
        return types[content_type]
    if data.startswith(b"\x89PNG"):
        return "png"
    if b"<svg" in data[:512].lower():
        return "svg"
    suffix = Path(urlparse(url).path).suffix.lower().lstrip(".")
    return suffix if suffix in {"ico", "png", "svg", "jpg", "jpeg", "gif", "webp"} else "ico"


def download_icon(url):
    candidates = icon_candidates(url)
    seen = set(candidates)
    candidates.extend(candidate for candidate in page_icon_candidates(url) if candidate not in seen)
    for candidate in candidates:
        request = Request(
            candidate,
            headers={
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urlopen(request, timeout=15) as response:
                data = response.read(MAX_BYTES + 1)
                content_type = response.headers.get_content_type().lower()
            if len(data) <= MAX_BYTES and looks_like_image(data, content_type):
                return data, extension_for(candidate, content_type, data)
        except (HTTPError, URLError, TimeoutError, ValueError):
            continue
    return None


def icon_path_for(item_id, extension):
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "-", str(item_id))
    return f"icons/{safe_id}.{extension}"


def source_hash(url):
    return hashlib.sha256(str(url).encode("utf-8")).hexdigest()[:16]


def manifest_entry(entry):
    if isinstance(entry, str):
        return {"path": entry, "sourceHash": ""}
    return entry if isinstance(entry, dict) else {}


def remove_old_icon(path):
    if not isinstance(path, str) or not path.startswith("icons/"):
        return
    old_file = ROOT / path
    if old_file.is_file():
        old_file.unlink()


def main():
    items = read_private_shortcuts()
    manifest = {}
    if ICON_MANIFEST_FILE.is_file():
        loaded = json.loads(ICON_MANIFEST_FILE.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            manifest = loaded

    ICON_DIR.mkdir(exist_ok=True)
    changed = False
    active_ids = set()
    for item in items:
        if not isinstance(item, dict) or not item.get("id") or not item.get("url"):
            continue
        item_id = str(item["id"])
        active_ids.add(item_id)
        url = str(item["url"])
        current = manifest_entry(manifest.get(item_id))
        current_path = current.get("path", "")
        if not isinstance(current_path, str):
            current_path = ""
        current_hash = current.get("sourceHash", "")
        if current_path.startswith("icons/") and (ROOT / current_path).is_file() and current_hash == source_hash(url):
            continue

        result = download_icon(url)
        if not result:
            if item_id in manifest:
                remove_old_icon(current_path)
                manifest.pop(item_id, None)
                changed = True
            print(f"未找到图标: {url}")
            continue

        data, extension = result
        relative_path = icon_path_for(item_id, extension)
        target = ROOT / relative_path
        target.write_bytes(data)
        if current_path and current_path != relative_path:
            remove_old_icon(current_path)
        next_entry = {"path": relative_path, "sourceHash": source_hash(url)}
        if manifest.get(item_id) != next_entry:
            manifest[item_id] = next_entry
            changed = True
        print(f"已保存图标: {relative_path}")

    for item_id in list(manifest):
        if item_id not in active_ids:
            remove_old_icon(manifest_entry(manifest[item_id]).get("path", ""))
            manifest.pop(item_id, None)
            changed = True

    if not changed:
        return
    ICON_MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, HTTPError, URLError) as error:
        print(f"图标抓取失败: {error}", file=sys.stderr)
        sys.exit(1)
