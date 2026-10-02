#!/usr/bin/env python3
"""Generate collections.json from the AstroBotany calibration database's
built-in collection list.

The calibration database (dr-richard-barker/AstroBotany_calibration_image_sharing_and_analysis)
keeps its built-in image collections as the TypeScript array `BUILTIN` in
src/api/epicollect.ts. astroroot-painter lists those collections in its dataset
dropdown, so this reads that array and writes the fields astroroot-painter uses.

Reads from GitHub by default, pinned to the current commit of `main` — a local
clone can be stale (the one in ~/Documents was 26 days behind on 2026-09-27).

    python3 scripts/sync_collections.py                 # regenerate from GitHub
    python3 scripts/sync_collections.py --check         # exit 1 if collections.json is out of date
    python3 scripts/sync_collections.py --local FILE    # parse a local epicollect.ts instead

Collections a user saves in the database themselves are NOT in this file: those
live in the browser (localStorage "ec5-projects"), which astroroot-painter reads
at runtime because both sites share the dr-richard-barker.github.io origin.
"""
import argparse
import json
import pathlib
import sys
import urllib.request

DB_REPO = "dr-richard-barker/AstroBotany_calibration_image_sharing_and_analysis"
DB_FILE = "src/api/epicollect.ts"
OUT = pathlib.Path(__file__).resolve().parents[1] / "collections.json"


class ParseError(ValueError):
    pass


class Parser:
    """Recursive descent over the JS literal subset BUILTIN uses: objects,
    arrays, quoted strings, numbers, true/false/null, and // or /* */ comments.
    Anything else (spreads, variable references, computed keys) is an error
    rather than a silent skip, so a refactor of BUILTIN fails loudly here."""

    def __init__(self, text, pos=0):
        self.s, self.i = text, pos

    def fail(self, msg):
        line = self.s.count("\n", 0, self.i) + 1
        raise ParseError(f"{msg} at line {line}: {self.s[self.i:self.i + 40]!r}")

    def ws(self):
        s = self.s
        while self.i < len(s):
            if s[self.i].isspace():
                self.i += 1
            elif s.startswith("//", self.i):
                nl = s.find("\n", self.i)
                self.i = len(s) if nl < 0 else nl + 1
            elif s.startswith("/*", self.i):
                end = s.find("*/", self.i + 2)
                if end < 0:
                    self.fail("unterminated comment")
                self.i = end + 2
            else:
                break

    def peek(self):
        self.ws()
        return self.s[self.i] if self.i < len(self.s) else ""

    def expect(self, ch):
        if self.peek() != ch:
            self.fail(f"expected {ch!r}")
        self.i += 1

    def value(self):
        c = self.peek()
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c in "'\"`":
            return self.string()
        return self.atom()

    def obj(self):
        self.expect("{")
        out = {}
        while self.peek() != "}":
            if self.s.startswith("...", self.i):
                self.fail("spread in object literal is not supported")
            key = self.string() if self.peek() in "'\"" else self.ident()
            self.expect(":")
            out[key] = self.value()
            if self.peek() == ",":
                self.i += 1
        self.i += 1
        return out

    def arr(self):
        self.expect("[")
        out = []
        while self.peek() != "]":
            if self.s.startswith("...", self.i):
                self.fail("spread in array literal is not supported")
            out.append(self.value())
            if self.peek() == ",":
                self.i += 1
        self.i += 1
        return out

    def ident(self):
        self.ws()
        j = self.i
        while j < len(self.s) and (self.s[j].isalnum() or self.s[j] in "_$"):
            j += 1
        if j == self.i:
            self.fail("expected an identifier")
        tok, self.i = self.s[self.i:j], j
        return tok

    def atom(self):
        self.ws()
        j = self.i
        while j < len(self.s) and (self.s[j].isalnum() or self.s[j] in "_$.+-"):
            j += 1
        tok, self.i = self.s[self.i:j], j
        if tok in ("true", "false"):
            return tok == "true"
        if tok == "null":
            return None
        try:
            return float(tok) if "." in tok else int(tok)
        except ValueError:
            self.i -= len(tok)
            self.fail("unsupported value (variable reference?)")

    ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}

    def string(self):
        q = self.s[self.i]
        self.i += 1
        out = []
        while True:
            if self.i >= len(self.s):
                self.fail("unterminated string")
            c = self.s[self.i]
            if c == q:
                self.i += 1
                return "".join(out)
            if q == "`" and self.s.startswith("${", self.i):
                self.fail("template interpolation is not supported")
            if c == "\\":
                n = self.s[self.i + 1]
                if n == "u":
                    out.append(chr(int(self.s[self.i + 2:self.i + 6], 16)))
                    self.i += 6
                    continue
                if n == "x":
                    out.append(chr(int(self.s[self.i + 2:self.i + 4], 16)))
                    self.i += 4
                    continue
                out.append(self.ESCAPES.get(n, n))
                self.i += 2
                continue
            out.append(c)
            self.i += 1


def parse_builtin(ts_text):
    """Return BUILTIN as a list of dicts with the fields astroroot-painter uses."""
    start = ts_text.index("const BUILTIN")
    bracket = ts_text.index("[", ts_text.index("=", start))
    return [normalise(o) for o in Parser(ts_text, bracket).arr()]


def normalise(o):
    out = {"slug": o["slug"], "name": o["name"], "type": o.get("type") or "ec5"}
    if "gh" in o:
        out["gh"] = {k: o["gh"][k] for k in ("owner", "repo", "ref", "path")}
    if o.get("formRef"):
        out["formRef"] = o["formRef"]
    prov = o.get("provenance") or {}
    for k in ("organism", "description"):
        if prov.get(k):
            out[k] = prov[k]
    return out


def fetch(url):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "astroroot-painter"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def build(local=None):
    if local:
        text = pathlib.Path(local).read_text(encoding="utf-8")
        source = f"local file {local} (not pinned to a commit)"
    else:
        sha = json.loads(fetch(f"https://api.github.com/repos/{DB_REPO}/commits/main"))["sha"]
        text = fetch(f"https://raw.githubusercontent.com/{DB_REPO}/{sha}/{DB_FILE}")
        source = f"https://github.com/{DB_REPO}/blob/{sha}/{DB_FILE}"
    return {
        "generated_by": "scripts/sync_collections.py — do not edit by hand",
        "source": source,
        "collections": parse_builtin(text),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--local", help="parse this epicollect.ts instead of fetching from GitHub")
    ap.add_argument("--check", action="store_true", help="exit 1 if collections.json would change")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()

    data = build(a.local)
    text = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    out = pathlib.Path(a.out)
    if a.check:
        current = json.loads(out.read_text(encoding="utf-8")) if out.exists() else None
        stale = current is None or current["collections"] != data["collections"]
        print(("OUT OF DATE: " if stale else "up to date: ") + f"{len(data['collections'])} collections from {data['source']}")
        sys.exit(1 if stale else 0)
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out} — {len(data['collections'])} collections from {data['source']}")


if __name__ == "__main__":
    main()
