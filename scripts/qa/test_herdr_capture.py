import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from PIL import Image

from herdr_capture import CSI, capture, graphemes, indexed, render


class CaptureTests(unittest.TestCase):
    def test_fixture_graphemes_preserve_combining_emoji_and_flags(self):
        self.assertEqual(graphemes("e\u0301👩‍💻🇯🇵"), ["e\u0301", "👩‍💻", "🇯🇵"])

    def test_xterm_palette(self):
        self.assertEqual(indexed(16), "#000000")
        self.assertEqual(indexed(21), "#0000ff")
        self.assertEqual(indexed(231), "#ffffff")
        self.assertEqual(indexed(232), "#080808")
        self.assertEqual(indexed(255), "#eeeeee")

    def test_plain_text_comes_from_the_styled_snapshot(self):
        self.assertEqual(CSI.sub("", "\x1b[38;2;1;2;3m你好\x1b[0m\n"), "你好\n")

    def test_unmanaged_capture_never_controls_herdr(self):
        with patch.dict("os.environ", {"HERDR_ENV": "0"}), patch("herdr_capture.command") as cli:
            with self.assertRaises(RuntimeError):
                capture("w1:p1", "/unused", "sample")
            cli.assert_not_called()

    def test_filename_traversal_is_rejected_before_io(self):
        with patch.dict("os.environ", {"HERDR_ENV": "1"}), patch("herdr_capture.command") as cli:
            with self.assertRaises(ValueError):
                capture("w1:p1", "/unused", "../overwrite")
            cli.assert_not_called()

    def test_image_allocation_is_bounded(self):
        with self.assertRaises(ValueError):
            render("", 1000000, 10, "/unused.png")

    def test_truecolor_background_is_rasterized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.png"
            render("\x1b[48;2;1;2;3m \x1b[0m", 3, 1, path)
            with Image.open(path) as image:
                self.assertEqual(image.getpixel((6, 6)), (1, 2, 3))

    def test_capture_reads_one_frame_for_both_artifacts(self):
        ansi = "\x1b[48;2;1;2;3mQA \x1b[0m\n"
        replies = [
            json.dumps({"result": {"pane": {"scroll": {"viewport_rows": 1}}}}),
            json.dumps({"result": {"layout": {"panes": [
                {"pane_id": "w1:p1", "rect": {"width": 3}}
            ]}}}),
            ansi,
        ]
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict("os.environ", {"HERDR_ENV": "1"}), patch(
                "herdr_capture.command", side_effect=replies
            ) as cli:
                result = capture("w1:p1", directory, "sample")
                self.assertEqual(cli.call_count, 3)
            self.assertTrue(Path(result["image"]).exists())
            self.assertEqual((Path(directory) / "sample.ansi").read_text(), ansi)
            self.assertEqual(Path(result["text"]).read_text(), "QA \n")


if __name__ == "__main__":
    unittest.main()
