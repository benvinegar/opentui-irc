"""Rasterize an explicitly targeted Herdr viewport; preserve its original ANSI too.

Optional Linux QA utility: requires Pillow, wcwidth and fontconfig. Font fallback
can differ from the host terminal. The ANSI/text artifacts are authoritative.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata

from PIL import Image, ImageDraw, ImageFont
from wcwidth import wcswidth

CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
DEFAULT_FG = "#e4e8f2"
DEFAULT_BG = "#161821"


def command(*args):
    return subprocess.run(
        ["herdr", *args], check=True, capture_output=True, text=True
    ).stdout


def graphemes(text):
    """Group the combining/emoji sequences used by the QA fixtures."""
    groups = []
    for ch in text:
        cp = ord(ch)
        flag_pair = (
            bool(groups)
            and 0x1F1E6 <= cp <= 0x1F1FF
            and len(groups[-1]) == 1
            and 0x1F1E6 <= ord(groups[-1]) <= 0x1F1FF
        )
        joins = bool(groups) and (
            unicodedata.category(ch) in ("Mn", "Mc", "Me")
            or 0xFE00 <= cp <= 0xFE0F
            or 0x1F3FB <= cp <= 0x1F3FF
            or ch == "\u200d"
            or groups[-1].endswith("\u200d")
            or flag_pair
        )
        if joins:
            groups[-1] += ch
        else:
            groups.append(ch)
    return groups


def indexed(index):
    standard = [
        "#000000", "#cd0000", "#00cd00", "#cdcd00",
        "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
        "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
        "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
    ]
    if index < 16:
        return standard[max(0, index)]
    if index < 232:
        levels = [0, 95, 135, 175, 215, 255]
        value = index - 16
        return "#%02x%02x%02x" % (
            levels[value // 36], levels[value // 6 % 6], levels[value % 6]
        )
    value = min(255, 8 + 10 * (index - 232))
    return "#%02x%02x%02x" % (value, value, value)


def render(ansi, columns, rows, path):
    if not (0 < columns <= 600 and 0 < rows <= 300 and columns * rows <= 120000):
        raise ValueError("Viewport exceeds the capture utility's bounded image size")
    font_path = subprocess.run(
        ["fc-match", "monospace", "-f", "%{file}"],
        check=True, capture_output=True, text=True,
    ).stdout
    font = ImageFont.truetype(font_path, 16)
    bold_path = font_path.replace("Regular", "Bold")
    bold_font = ImageFont.truetype(
        bold_path if Path(bold_path).exists() else font_path, 16
    )
    cell_width, cell_height = round(font.getlength("M")), 21
    image = Image.new(
        "RGB", (columns * cell_width + 12, rows * cell_height + 12), DEFAULT_BG
    )
    draw = ImageDraw.Draw(image)
    fg, bg, bold, reverse, underline = DEFAULT_FG, DEFAULT_BG, False, False, False
    x, y = 0, 0
    for token in re.split("(" + CSI.pattern + ")", ansi):
        if token.startswith("\x1b["):
            if not token.endswith("m"):
                continue
            codes = [int(value or 0) for value in token[2:-1].split(";")]
            i = 0
            while i < len(codes):
                code = codes[i]
                if code == 0:
                    fg, bg = DEFAULT_FG, DEFAULT_BG
                    bold, reverse, underline = False, False, False
                elif code in (1, 22):
                    bold = code == 1
                elif code in (4, 24):
                    underline = code == 4
                elif code in (7, 27):
                    reverse = code == 7
                elif code == 39:
                    fg = DEFAULT_FG
                elif code == 49:
                    bg = DEFAULT_BG
                elif 30 <= code <= 37 or 90 <= code <= 97:
                    fg = indexed(code - 30 if code < 90 else code - 90 + 8)
                elif 40 <= code <= 47 or 100 <= code <= 107:
                    bg = indexed(code - 40 if code < 100 else code - 100 + 8)
                elif code in (38, 48) and i + 1 < len(codes):
                    color = None
                    if codes[i + 1] == 2 and i + 4 < len(codes):
                        color = "#%02x%02x%02x" % tuple(codes[i + 2:i + 5])
                        i += 4
                    elif codes[i + 1] == 5 and i + 2 < len(codes):
                        color = indexed(codes[i + 2])
                        i += 2
                    if color:
                        if code == 38:
                            fg = color
                        else:
                            bg = color
                i += 1
            continue
        for ch in graphemes(token):
            if ch == "\r":
                x = 0
                continue
            if ch == "\n":
                y += 1
                x = 0
                continue
            width = wcswidth(ch)
            if width <= 0:
                continue
            if y >= rows:
                break
            ink, paper = (bg, fg) if reverse else (fg, bg)
            left, top = 6 + x * cell_width, 6 + y * cell_height
            draw.rectangle(
                (left, top, left + width * cell_width - 1, top + cell_height - 1),
                fill=paper,
            )
            draw.text((left, top), ch, font=bold_font if bold else font, fill=ink)
            if underline:
                draw.line(
                    (left, top + cell_height - 3,
                     left + width * cell_width, top + cell_height - 3),
                    fill=ink,
                )
            x += width
    image.save(path)


def capture(pane, directory, label):
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Run inside the explicitly requested Herdr session")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", label):
        raise ValueError("Use a simple filename label, not a path")
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = json.loads(command("pane", "get", pane))["result"]["pane"]
    layout = json.loads(command("pane", "layout", "--pane", pane))["result"]["layout"]
    rect = next(item["rect"] for item in layout["panes"] if item["pane_id"] == pane)
    ansi = command(
        "pane", "read", pane, "--source", "visible", "--format", "ansi",
        "--lines", "1000",
    )
    # Derive both artifacts from one viewport read, even while chat is arriving.
    plain = CSI.sub("", ansi)
    (directory / (label + ".ansi")).write_text(ansi)
    (directory / (label + ".txt")).write_text(plain)
    (directory / (label + ".json")).write_text(
        json.dumps({"pane": info, "layout": layout}, indent=2)
    )
    columns = max(rect["width"], max((wcswidth(line) for line in plain.splitlines()), default=0))
    rows = max(info["scroll"]["viewport_rows"], len(plain.splitlines()))
    image_path = directory / (label + ".png")
    render(ansi, columns, rows, image_path)
    return {
        "pane": pane, "label": label, "image": str(image_path),
        "text": str(directory / (label + ".txt")),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pane", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    print(json.dumps(capture(args.pane, args.directory, args.label)))
