import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "shortcuts.json"
ICON_DIR = ROOT / "icons"
MAX_BYTES = 512 * 1024
USER_AGENT = "navi-icon-fetcher/1.0 (+https://github.com/)"


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
        return b"<html" not in sample and b"<script" not in sample
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
    for candidate in icon_candidates(url):
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


def remove_old_icon(item):
    old = str(item.get("icon") or "")
    if not old.startswith("icons/"):
        return
    old_file = ROOT / old
    if old_file.is_file():
        old_file.unlink()


def main():
    document = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    if isinstance(document, list):
        items = document
    else:
        items = document.get("items", [])
    if not isinstance(items, list):
        raise ValueError("shortcuts.json 的 items 必须是数组")

    ICON_DIR.mkdir(exist_ok=True)
    changed = False
    for item in items:
        if not isinstance(item, dict) or not item.get("id") or not item.get("url"):
            continue

        current = str(item.get("icon") or "")
        if current.startswith("icons/") and (ROOT / current).is_file():
            continue

        result = download_icon(str(item["url"]))
        if not result:
            if current:
                item.pop("icon", None)
                changed = True
            print(f"未找到图标: {item['url']}")
            continue

        data, extension = result
        relative_path = icon_path_for(item["id"], extension)
        target = ROOT / relative_path
        target.write_bytes(data)
        if current and current != relative_path:
            remove_old_icon(item)
        if item.get("icon") != relative_path:
            item["icon"] = relative_path
            changed = True
        print(f"已保存图标: {relative_path}")

    if not changed:
        return

    if isinstance(document, list):
        output = items
    else:
        document["items"] = items
        output = document
    DATA_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"图标抓取失败: {error}", file=sys.stderr)
        sys.exit(1)
