# astroroot-painter

A browser front end for [RootPainter](https://github.com/Abe404/root_painter)'s
corrective-annotation training loop — astroroot's training/correction companion.

RootPainter (Smith et al. 2022, *New Phytologist* 236(2):774–791,
[doi:10.1111/nph.18387](https://doi.org/10.1111/nph.18387), open access, CC-BY-4.0 —
verified against CrossRef) lets you train a segmentation model by painting corrections
on top of its own live predictions, instead of hand-labeling full ground truth. The
paper trained models for chicory root length in soil, biopore counting, and root-nodule
counting; 5 of 6 converged to strong agreement with manual measurement inside 2 hours of
corrective annotation.

This repository does not reimplement that method — it gives RootPainter's real,
unmodified trainer a browser front end, using the same file-sync folder its own desktop
client already uses, so it's usable from a CoSE Pages-style web page instead of a
PyQt5 install.

## Why this exists

[astroroot](https://github.com/dr-richard-barker/astroroot) already does in-browser root
segmentation and measurement, but its own "train a custom model" path is a manual,
undocumented-as-automation recipe (export a label set, follow a third-party repo's
training instructions by hand, re-import a single ONNX file). TICTOC has pouch root
images where the root is fused to the border, a label block, and speckled substrate as
one connected component — global Otsu, morphological top-hat, and Feret filtering all
fail on it, because the problem is connectivity, not contrast. That's exactly the shape
of problem corrective annotation is for: a human fixes what the current model gets
wrong, instead of hand-tracing everything.

## Status

| Piece | Status |
|---|---|
| Dataset dropdown lists the [AstroBotany calibration database](https://dr-richard-barker.github.io/AstroBotany_calibration_image_sharing_and_analysis/)'s collections — its built-in ones plus any you've saved there — and you can browse and paint them **before mounting anything** | Built and verified in the browser (`tests/smoke.js`) against the live GitHub and Epicollect5 APIs |
| Corrective-annotation brush (`paint.js`) — RGBA export matching RootPainter's exact format | Verified: every annotation pixel is exactly root `rgba(255,0,0,180)`, soil `rgba(0,255,0,180)` or unpainted, and a browser-exported annotation decodes that way through the trainer's own `imread`. *Corrections:* the first brush blended colours, so painting soil over root left pixels that were both, and erasing left a faint painted ring; it now replaces pixels the way RootPainter's desktop client does. An earlier check also missed that loaded images were displayed at 0×0 on screen. Both are fixed, and `tests/smoke.js` covers them |
| Saving (`tests/mounted.js`, run against an in-browser stand-in folder because the real picker can't be automated) | Verified: saving before mounting asks for the folder, creates the project and copies the image in byte-for-byte; an image's annotation is in exactly one of train/val; paint made before mounting is merged with an annotation already saved rather than overwriting it; saving nothing removes the annotation instead of writing an empty one (which would break the trainer) |
| Protocol correctness against the real trainer (`root-painter-trainer==0.3.0`) | Verified by writing instructions and annotations in exactly this client's format: all four instruction types executed and real training steps ran on Apple-silicon MPS. Training was stopped before its first epoch finished, so no *trained* model exists yet — the test segmentation came from the initial untrained model. Found on the way: training silently never starts without at least one *validation* annotation — the UI now blocks that case ([`docs/PROTOCOL.md`](docs/PROTOCOL.md)) |
| Stub trainer for interface testing without a GPU (`scripts/fake-syncdir/fake_trainer.py`) | Built and exercised end to end (all 4 instruction types, success and failure paths) |
| One continuous live session: paint → save → train → segment, driven from the browser | **Not yet done** — needs a person at Chrome/Edge to answer the folder picker, which no automation can do |
| TICTOC pilot vs. the 198 ground-truth RSML tracings | **Not started** |

Nothing above is a claim about model accuracy — none has been produced yet. See
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) for exactly what was verified and how.

## Try it

Open **https://dr-richard-barker.github.io/astroroot-painter/**, pick a collection from the
dataset dropdown, and paint. Nothing needs installing to browse and paint.

To **save annotations and train**, you need a RootPainter trainer running (see
[`docs/TRAINING.md`](docs/TRAINING.md)) and **Chrome or Edge** (other browsers can browse
and paint, but can't write to a local folder). The first time you save, the page asks for
the sync folder — the one you passed to `start-trainer --syncdir`. It then copies the
image you annotated into that folder's `datasets/`, creates a project for the collection,
and writes the annotation where the trainer expects it.

To run it locally instead: `python3 -m http.server 8000` in this folder, then open
`http://localhost:8000`. (Collections you've saved in the database only show up on the
`dr-richard-barker.github.io` site itself — see below.)

## Architecture

```
browser (this repo, static)  <--File System Access API-->  shared folder  <--watched by-->  RootPainter trainer
                                                                                              (unmodified, external:
                                                                                               local GPU, Colab, or ssh)
```

RootPainter's code is never vendored here — it's installed separately
(`pip install root-painter-trainer`) and run as-is. This repo only reads and writes the
plain files its trainer already understands: JSON instructions, RGBA annotation PNGs,
and its `.seg_proj`/log files. The exact protocol, as read from the trainer's own source
and confirmed by running it, is documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

### Where the datasets come from

The dropdown reads the AstroBotany calibration database's collections the same way the
database itself does, straight from the browser (both APIs are CORS-open):

- **Built-in collections** come from [`collections.json`](collections.json), generated from
  the database's own source by `python3 scripts/sync_collections.py` and pinned to the
  commit it was read from. Re-run it after adding a collection to the database;
  `--check` reports whether the copy here is out of date.
- **Collections you saved in the database** are read from the browser's storage
  (`localStorage["ec5-projects"]`, the database's own key). This works because both sites
  are served from `dr-richard-barker.github.io`, and browser storage is shared per site —
  so it only works there, not on a local copy.
- Images are listed from the GitHub contents API (folders) or the Epicollect5 entries API
  (projects), and drawn directly from their URLs. Uploads, cloud collections and videos
  saved in the database aren't readable here yet; TIFFs are listed as skipped because
  browsers can't decode them (RootPainter itself can).

A database image only gets copied into your sync folder's `datasets/db-<name>-<id>/` when
it's needed on disk — when you save an annotation on it or ask the trainer to segment it.

Tests: `python3 tests/test_sync_collections.py` (the generator, against the database's
real source); `tests/smoke.js` (paste into the page's console; everything that works
before a folder is mounted); `tests/mounted.js` (the same, for saving — uses a folder in
the browser's private storage in place of the picker, and says when to reload and rerun).

A RootPainter-trained model is **not** interchangeable with astroroot's existing ONNX
model slot — RootPainter trains a 2-channel (background/foreground), tiled,
valid-convolution U-Net; astroroot's bundled model is a fixed-resize, 6-channel RootNav2
network. They're different model profiles by design, and no ONNX export path exists for
RootPainter upstream (checked: none in its source). A shared-viewer bridge between the
two is future work, not something this version claims.

## License

GPLv3 (see [`LICENSE`](LICENSE)). This repository's code is written directly against
RootPainter's own file protocol, not called through a stable arm's-length API, so it
ships under the same license family rather than this portfolio's usual MIT-for-tools
default. See [`NOTICE`](NOTICE) for the full reasoning and attribution, including a
footnote on an upstream license-metadata inconsistency worth knowing about if you go
looking for it yourself.

## Relationship to the rest of this portfolio

Part of the CoSE / AstroBotany tool family, alongside
[astroroot](https://github.com/dr-richard-barker/astroroot) (in-browser root
segmentation and measurement) and
[cose-fiji](https://github.com/dr-richard-barker/cose-fiji) (whose File System Access
API pattern this repository's `syncfs.js` adapts). Listed in the CoSE hub under
AstroBotany → Tools. Its dataset dropdown reads the
[AstroBotany calibration database](https://github.com/dr-richard-barker/AstroBotany_calibration_image_sharing_and_analysis);
registering it as a tool *inside* that database (so it opens from there) is planned but
not done.
