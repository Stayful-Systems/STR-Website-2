"""Unit tests for ld_common.py (the lead database videos). Run: python3 -m unittest discover -s ad-render/tests"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from PIL import Image  # noqa: E402

import ld_common as L  # noqa: E402
from video import Canvas, H, W, pick_crops  # noqa: E402


class SceneTimes(unittest.TestCase):
    def test_five_lines_map_one_to_one(self):
        lines = [{"start": s} for s in (0.2, 3.0, 6.0, 9.0, 12.0)]
        t = L.scene_times(lines, 14.0)
        self.assertEqual(len(t), 5)
        self.assertEqual(t[0], 0.0)
        self.assertAlmostEqual(t[4], 12.0 - L.LEAD)

    def test_four_lines_spread_the_middle_and_end_on_the_cta(self):
        lines = [{"start": s} for s in (0.2, 4.0, 8.0, 12.0)]
        t = L.scene_times(lines, 14.0)
        self.assertEqual(len(t), 5)
        self.assertTrue(all(b > a for a, b in zip(t, t[1:])))
        self.assertAlmostEqual(t[-1], 12.0 - L.LEAD)


class Fitting(unittest.TestCase):
    def test_fit_rect_scales_down_keeping_the_shape(self):
        self.assertEqual(L.fit_rect(1190, 1684, 960, 510), (360, 510))
        self.assertEqual(L.fit_rect(100, 50, 960, 510), (960, 480))

    def test_a_page_card_holds_the_whole_page_inside_960(self):
        page = Image.new("RGB", (1190, 1500), (10, 10, 10))
        card = L.page_card(page)
        self.assertLessEqual(card.width, L.CARD_MAX_W)
        self.assertLessEqual(card.height, L.CONTENT_BOTTOM - L.CONTENT_TOP)


class NeverBlurred(unittest.TestCase):
    def test_the_ground_is_the_ads_own_solid_base_and_the_crops_cut_it_without_blur(self):
        for base in L.BASES:
            pal = L.palette_v2((31, 78, 121), L.theme.parse_hex(base))
            bg = L.background(pal)
            cv = Canvas(bg.copy())
            spr = Image.new("RGBA", (400, 400), (31, 78, 121, 255))
            cv.put(spr, 340, 600)
            crops = pick_crops((cv.box[1] - 300, cv.box[3] + 150))
            for name, h in (("4x5", 1350), ("1x1", 1080)):
                part = cv.im.crop((0, crops[name], W, crops[name] + h))
                # everything outside the content is exactly the base colour: padding, never a blurred copy
                self.assertEqual(part.getpixel((5, 5)), pal["base"])
                self.assertEqual(part.getpixel((W - 5, h - 5)), pal["base"])
                colours = set(part.getdata())
                self.assertLessEqual(len(colours), 2, "only the base and the content")

    def test_the_brand_colour_is_only_for_strip_bar_highlight_and_button(self):
        pal = L.palette_v2((200, 30, 30), (245, 244, 237))
        self.assertEqual(pal["base"], (245, 244, 237))
        self.assertEqual(pal["brand"], (200, 30, 30))


class Measure(unittest.TestCase):
    def test_first_frame_stats_shape(self):
        st = L.first_frame_stats(Image.new("RGB", (W, H), (245, 244, 237)))
        self.assertEqual(len(st["hist"]), 64)
        self.assertEqual(len(st["thumb"]), 32 * 32)
        self.assertAlmostEqual(sum(st["hist"]), 1.0, places=3)


class Briefs(unittest.TestCase):
    def test_safe_rel(self):
        self.assertTrue(L.safe_rel("assets/page-1.png"))
        for bad in ("/abs", "../x", "a/../b", "c:\\x", ""):
            self.assertFalse(L.safe_rel(bad))


if __name__ == "__main__":
    unittest.main()
