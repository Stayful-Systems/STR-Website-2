"""Unit tests for example_pages.py (run: python3 -m unittest discover -s ad-render/tests)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from PIL import Image  # noqa: E402

import example_pages as ep  # noqa: E402

XHTML = """<html><body><doc>
<page width="595.0" height="842.0"><flow><block>
<line xMin="40" yMin="100" xMax="300" yMax="112"><word xMin="40" yMin="100" xMax="90" yMax="112">Gross</word><word xMin="92" yMin="100" xMax="140" yMax="112">revenue</word><word xMin="200" yMin="100" xMax="260" yMax="112">&#163;31,200</word></line>
<line xMin="40" yMin="140" xMax="300" yMax="152"><word xMin="40" yMin="140" xMax="80" yMax="152">Net</word><word xMin="200" yMin="140" xMax="206" yMax="152">£</word><word xMin="207" yMin="140" xMax="250" yMax="152">1,950</word></line>
<line xMin="40" yMin="300" xMax="300" yMax="312"><word xMin="40" yMin="300" xMax="120" yMax="312">OCCUPANCY</word><word xMin="200" yMin="300" xMax="230" yMax="312">71%</word></line>
<line xMin="40" yMin="340" xMax="300" yMax="352"><word xMin="40" yMin="340" xMax="120" yMax="352">Management</word><word xMin="200" yMin="340" xMax="215" yMax="352">15</word><word xMin="216" yMin="340" xMax="224" yMax="352">%</word></line>
</block></flow></page>
<page width="595.0" height="842.0"><flow><block>
<line xMin="40" yMin="200" xMax="300" yMax="212"><word xMin="40" yMin="200" xMax="80" yMax="212">Other</word><word xMin="82" yMin="200" xMax="140" yMax="212">listings</word></line>
<line xMin="40" yMin="500" xMax="300" yMax="512"><word xMin="40" yMin="500" xMax="90" yMax="512">Market</word><word xMin="92" yMin="500" xMax="140" yMax="512">demand</word></line>
</block></flow></page>
</doc></body></html>"""

SPECS = [
    {"id": "comparables", "headings": ["Other listings"]},
    {"id": "occupancy", "headings": ["OCCUPANCY"]},
    {"id": "demand", "headings": ["Market demand"]},
]


class ParseTests(unittest.TestCase):
    def test_parse_reads_every_word_with_its_box(self):
        pages = ep.parse_bbox(XHTML)
        self.assertEqual(len(pages), 2)
        self.assertEqual(pages[0]["width"], 595.0)
        self.assertEqual(pages[0]["lines"][0][2]["text"], "£31,200")

    def test_every_pound_word_is_masked_and_nothing_else(self):
        pages = ep.parse_bbox(XHTML)
        boxes = ep.pound_boxes(pages[0]["lines"])
        self.assertEqual(len(boxes), 2)
        self.assertEqual(boxes[0]["text"], "£31,200")
        # A bare "£" takes the number after it.
        self.assertEqual(boxes[1]["x1"], 250.0)
        # Percentages are percent_boxes' job; the section names stay readable.
        self.assertFalse(any("%" in b["text"] or "OCCUPANCY" in b["text"] for b in boxes))
        self.assertEqual(ep.pound_boxes(pages[1]["lines"]), [])

    def test_every_percentage_is_masked_and_the_labels_stay(self):
        pages = ep.parse_bbox(XHTML)
        boxes = ep.percent_boxes(pages[0]["lines"])
        self.assertEqual(len(boxes), 2)
        self.assertEqual(boxes[0]["text"], "71%")
        # A bare "%" takes the number before it.
        self.assertEqual((boxes[1]["x0"], boxes[1]["x1"]), (200.0, 224.0))
        self.assertFalse(any(b["text"] in ("OCCUPANCY", "Management") for b in boxes))
        self.assertEqual(ep.percent_boxes(pages[1]["lines"]), [])
        # A word with no number before the % is left alone.
        self.assertEqual(ep.percent_boxes([[{"x0": 0, "y0": 0, "x1": 1, "y1": 1, "text": "%"}]]), [])

    def test_targets_come_from_the_headings_in_order(self):
        t = ep.find_targets(ep.parse_bbox(XHTML), SPECS)
        self.assertEqual([x["page"] for x in t], [1, 0, 1])
        for x in t:
            self.assertTrue(0 <= x["y"] <= 1 - ep.STOP_H)
            self.assertEqual(x["w"], ep.STOP_W)

    def test_a_missing_heading_is_a_code(self):
        with self.assertRaises(ep.JobError) as cm:
            ep.find_targets(ep.parse_bbox(XHTML), [{"id": "x", "headings": ["Nowhere here"]}])
        self.assertEqual(cm.exception.code, "no_target")


class ImageTests(unittest.TestCase):
    def test_blur_changes_only_the_box(self):
        img = Image.new("RGB", (200, 100), (245, 244, 237))
        for x in range(60, 140, 4):
            for y in range(40, 60):
                img.putpixel((x, y), (0, 0, 0))
        before = img.copy()
        ep.blur_region(img, (55, 35, 145, 65))
        self.assertEqual(img.getpixel((10, 10)), before.getpixel((10, 10)))
        self.assertEqual(img.getpixel((190, 90)), before.getpixel((190, 90)))
        # Inside, the hard black strokes are gone (no pixel is near black any more).
        inside = [img.getpixel((x, y)) for x in range(60, 140) for y in range(40, 60)]
        self.assertTrue(min(sum(p) for p in inside) > 150)

    def test_scale_box_maps_points_to_pixels(self):
        r = ep.scale_box({"x0": 100, "y0": 100, "x1": 200, "y1": 112}, 595, 842, 1190, 1684, pad=0)
        self.assertEqual(r, (200, 200, 400, 224))

    def test_stamp_sits_inside_the_page_top_right(self):
        img = Image.new("RGB", (1190, 1684), (255, 255, 255))
        x0, y0, x1, y1 = ep.stamp(img, "Example report", "#1F4E79")
        self.assertTrue(x0 > img.width // 2 and x1 < img.width and y0 > 0 and y1 < img.height // 10)
        self.assertNotEqual(img.getpixel((x0 + 3, y0 + (y1 - y0) // 2)), (255, 255, 255))


if __name__ == "__main__":
    unittest.main()
