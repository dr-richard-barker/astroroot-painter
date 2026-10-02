"""Tests for scripts/sync_collections.py, run against the calibration database's
real epicollect.ts (fetched from GitHub, not a local clone — the local clone was
found 26 days stale on 2026-09-27).

    python3 tests/test_sync_collections.py
"""
import importlib.util
import pathlib
import re
import unittest
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
SRC_URL = ("https://raw.githubusercontent.com/dr-richard-barker/"
           "AstroBotany_calibration_image_sharing_and_analysis/main/src/api/epicollect.ts")


def load_module():
    spec = importlib.util.spec_from_file_location("sync_collections", REPO / "scripts" / "sync_collections.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestParseBuiltin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ts = urllib.request.urlopen(SRC_URL, timeout=30).read().decode("utf-8")
        cls.mod = load_module()
        cls.entries = cls.mod.parse_builtin(cls.ts)

    def test_entry_count_matches_an_independent_count(self):
        # Counted a different way from the parser (plain text between the array's
        # bounds), so a parser bug can't make both sides agree.
        block = self.ts[self.ts.index("const BUILTIN"):]
        block = block[:block.index("\n];")]
        expected = len(re.findall(r"^\s*(?:\{\s*)?slug:", block, re.M))
        self.assertGreater(expected, 0)
        self.assertEqual(len(self.entries), expected)

    def test_github_entry_fields(self):
        apex = next(e for e in self.entries if "APEX05/images" in e["slug"])
        self.assertEqual(apex["type"], "github")
        self.assertEqual(apex["name"], "APEX05 — root architecture (Flight vs GC)")
        self.assertEqual(apex["gh"], {"owner": "dr-richard-barker", "repo": "image-analysis-software-and-R-codes",
                                      "ref": "master", "path": "APEX05/images"})
        self.assertEqual(apex["organism"], "Arabidopsis thaliana")

    def test_epicollect_entry_defaults_to_ec5(self):
        nr = next(e for e in self.entries if e["slug"] == "nasa-roots")
        self.assertEqual(nr["type"], "ec5")
        self.assertEqual(nr["name"], "NASA Roots")
        self.assertNotIn("gh", nr)

    def test_form_ref_carried_through(self):
        gc = next(e for e in self.entries if e["slug"] == "greencompanions")
        self.assertEqual(gc["formRef"], "ea9a607f7c014276bc7bce0a2e794167_5ff90e8cdb1ba")

    def test_every_github_entry_is_complete(self):
        for e in (e for e in self.entries if e["type"] == "github"):
            for k in ("owner", "repo", "ref", "path"):
                self.assertTrue(e["gh"].get(k), f"{e['slug']} missing gh.{k}")
            self.assertEqual(e["slug"], "gh:{owner}/{repo}/{ref}/{path}".format(**e["gh"]))

    def test_curly_apostrophe_survives(self):
        # The MadWest description contains a literal U+2019 inside a single-quoted string.
        mw = next(e for e in self.entries if e["slug"].endswith("assets/timelapse"))
        self.assertIn("program’s", mw["description"])


if __name__ == "__main__":
    unittest.main()
