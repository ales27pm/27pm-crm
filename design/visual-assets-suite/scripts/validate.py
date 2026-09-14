from html.parser import HTMLParser
from pathlib import Path
import hashlib
import json
import re

from PIL import Image, ImageChops


R = Path(__file__).resolve().parents[1]
A = R / "public/visual-assets"
REPO = R.parents[1]
errors = []


def check(ok, message):
    if not ok:
        errors.append(message)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        errors.append(f"{path.name}: {error}")
        return default


def svg_details(path):
    source = path.read_text(encoding="utf-8")
    root = re.search(r"<svg\b(?P<attrs>[^>]*)>", source, re.IGNORECASE | re.DOTALL)
    check(root is not None, f"Not SVG: {path}")
    if root is None:
        return source, None
    view_box = re.search(
        r"\bviewBox\s*=\s*(['\"])(?P<value>.*?)\1",
        root.group("attrs"),
        re.IGNORECASE | re.DOTALL,
    )
    return source, view_box.group("value") if view_box else None


svg_files = list(R.rglob("*.svg"))
svg_cache = {}
for path in svg_files:
    try:
        source, view_box = svg_details(path)
        svg_cache[path.resolve()] = (source, view_box)
        check(view_box is not None or path.name == "sprite.svg", f"Missing viewBox: {path}")
    except Exception as error:
        errors.append(f"{path.name}: {error}")

images = []
for path in R.rglob("*"):
    if path.suffix not in [".png", ".webp", ".ico"]:
        continue
    try:
        with Image.open(path) as image:
            image.load()
            images.append(
                {
                    "path": str(path.relative_to(R)),
                    "width": image.width,
                    "height": image.height,
                    "mode": image.mode,
                }
            )
    except Exception as error:
        errors.append(f"{path.name}: {error}")

webp_checks = []
backgrounds = list((A / "backgrounds").glob("*.png"))
for path in backgrounds:
    pair_ok = False
    try:
        with Image.open(path) as original, Image.open(path.with_suffix(".webp")) as webp:
            pair_ok = (
                original.size == webp.size
                and ImageChops.difference(
                    original.convert("RGB"), webp.convert("RGB")
                ).getbbox()
                is None
            )
            check(pair_ok, "WebP differs: " + path.name)
    except Exception as error:
        errors.append(f"WebP pair {path.name}: {error}")
    webp_checks.append(pair_ok)

illustration_pngs = list((A / "illustrations").glob("*.png"))
for path in illustration_pngs:
    try:
        with Image.open(path) as image:
            image.load()
            check(
                image.mode == "RGBA" and image.getchannel("A").getextrema()[0] == 0,
                "Illustration alpha missing: " + path.name,
            )
    except Exception as error:
        errors.append(f"Illustration {path.name}: {error}")

icons = load_json(A / "icons/index.json", {"count": 0, "icons": []})
icon_entries = icons.get("icons", [])
check(icons.get("count") == len(icon_entries) == 40, "Icon count")
check(
    sum(icon.get("origin") == "existing-crm-geometry" for icon in icon_entries) == 24,
    "Original icon count",
)
try:
    sprite_source = (A / "icons/sprite.svg").read_text(encoding="utf-8")
    sprite_ids = set(
        re.findall(
            r"<symbol\b[^>]*\bid\s*=\s*['\"]([^'\"]+)['\"]",
            sprite_source,
            re.IGNORECASE | re.DOTALL,
        )
    )
except Exception as error:
    errors.append(f"sprite.svg: {error}")
    sprite_ids = set()
for icon in icon_entries:
    check(icon.get("symbol_id") in sprite_ids, "Missing sprite id: " + str(icon.get("id")))

illustrations = load_json(
    A / "illustrations/index.json", {"count": 0, "illustrations": []}
)
illustration_entries = illustrations.get("illustrations", [])
check(
    illustrations.get("count") == len(illustration_entries) == 10,
    "Illustration count",
)
for illustration in illustration_entries:
    illustration_id = str(illustration.get("id"))
    file_reference = str(illustration.get("file", ""))
    component_reference = str(illustration.get("component", ""))
    asset_path = R / "public" / file_reference.removeprefix("/")
    component_path = REPO / component_reference
    check(asset_path.is_file(), "Missing illustration file: " + illustration_id)
    check(component_path.is_file(), "Missing illustration component: " + illustration_id)
    if not asset_path.is_file():
        continue
    try:
        source, view_box = svg_cache.get(asset_path.resolve()) or svg_details(asset_path)
        check(view_box == illustration.get("viewBox"), "Illustration viewBox: " + illustration_id)
        colors = {color.upper() for color in re.findall(r"#[0-9a-fA-F]{6}", source)}
        declared_colors = {
            str(color).upper() for color in illustration.get("palette", [])
        }
        check(colors == declared_colors, "Illustration palette: " + illustration_id)
    except Exception as error:
        errors.append(f"Illustration metadata {illustration_id}: {error}")


class Links(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        for key in ["src", "href"]:
            if key not in attributes:
                continue
            value = attributes[key]
            if not value or value.startswith(("data:", "http:", "https:", "#", "mailto:")):
                continue
            target = (R / value.split("#")[0]).resolve()
            check(
                target.is_relative_to(R.resolve()) and target.is_file(),
                "Broken gallery reference: " + value,
            )


try:
    Links().feed((R / "index.html").read_text(encoding="utf-8"))
except Exception as error:
    errors.append(f"index.html: {error}")


def luminance(color):
    rgb = [int(color[index : index + 2], 16) / 255 for index in [1, 3, 5]]
    channels = [
        value / 12.92
        if value <= 0.04045
        else ((value + 0.055) / 1.055) ** 2.4
        for value in rgb
    ]
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


contrast = []
for title, foreground, background in [
    ("Carbon/ivory", "#171714", "#F4F0E7"),
    ("Cobalt/ivory", "#2846B8", "#F4F0E7"),
    ("Muted/ivory", "#65625B", "#F4F0E7"),
    ("Success text/surface", "#225C3A", "#E3F1E8"),
    ("Warning text/surface", "#8A4D18", "#FFF4E7"),
    ("Danger/ivory", "#B3312F", "#F4F0E7"),
]:
    low, high = sorted([luminance(foreground), luminance(background)])
    ratio = (high + 0.05) / (low + 0.05)
    contrast.append({"pair": title, "ratio": round(ratio, 2)})
    check(ratio >= 4.5, "Text contrast fails: " + title)

manifest = load_json(R / "manifest.json", {"fileCount": 0, "files": []})
manifest_entries = manifest.get("files", [])
manifest_paths = [str(entry.get("path")) for entry in manifest_entries]
generated_paths = sorted(
    str(path.relative_to(R))
    for path in R.rglob("*")
    if path.is_file() and path.name not in ["manifest.json", "validation.json"]
)
check(len(manifest_paths) == len(set(manifest_paths)), "Duplicate manifest path")
check(manifest.get("fileCount") == len(manifest_entries), "Manifest fileCount")
check(sorted(manifest_paths) == generated_paths, "Manifest file set")
for entry in manifest_entries:
    path = R / str(entry.get("path"))
    try:
        check(
            path.is_file()
            and hashlib.sha256(path.read_bytes()).hexdigest() == entry.get("sha256"),
            "Manifest mismatch: " + str(entry.get("path")),
        )
    except Exception as error:
        errors.append(f"Manifest {entry.get('path')}: {error}")

report = {
    "status": "pass" if not errors else "fail",
    "svgFiles": len(svg_files),
    "decodedImages": len(images),
    "icons": len(icon_entries),
    "preservedIcons": sum(
        icon.get("origin") == "existing-crm-geometry" for icon in icon_entries
    ),
    "illustrations": len(illustration_entries),
    "generatedBackgrounds": len(backgrounds),
    "losslessWebP": bool(webp_checks) and all(webp_checks),
    "contrast": contrast,
    "images": images,
    "errors": errors,
    "limits": [
        "Live CRM not inspected: Opera navigation unavailable.",
        "Gallery browser rendering and interaction not verified: Cloud browser blocked local URL.",
        "No CRM deployment or authentication behavior tested.",
    ],
}
(R / "docs/validation.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print(
    json.dumps(
        {key: value for key, value in report.items() if key not in ["images", "limits"]},
        ensure_ascii=False,
    )
)
raise SystemExit(bool(errors))
