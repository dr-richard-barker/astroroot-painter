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

## Status (Phase 1 of the project plan)

| Piece | Status |
|---|---|
| File System Access API folder mount + protocol layer (`syncfs.js`, `rootpainter-protocol.js`) | Built, unit-tested against a stub filesystem |
| Corrective-annotation brush (`paint.js`) — RGBA export matching RootPainter's exact format | Built and verified: painted foreground exports as `rgba(255,0,0,180)`, background as `rgba(0,255,0,180)`, unpainted stays fully transparent |
| Protocol correctness against the real trainer | Verified: installed `root-painter-trainer==0.3.0` and ran it against a throwaway sync dir — it created exactly the 5 folders this client expects |
| Stub trainer for interface testing without a GPU (`scripts/fake-syncdir/fake_trainer.py`) | Built and exercised end to end (all 4 instruction types, success and failure paths) |
| Live corrective-training loop against the real PyTorch trainer | **Not yet run** — needs a live Chrome/Edge session to click through the native folder picker, which this development environment's sandboxed browser cannot do |
| TICTOC pilot vs. the 198 ground-truth RSML tracings | **Not started** |

Nothing above is a claim about model accuracy — none has been produced yet. See
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) for exactly what was verified and how.

## Try it

```bash
python3 -m http.server 8000   # from this directory
```

Open `http://localhost:8000` in **Chrome or Edge 86+** (the File System Access API isn't
available elsewhere). Click **Mount sync folder…** and pick a folder — either one a real
`start-trainer` process is watching, or one `scripts/fake-syncdir/fake_trainer.py` is
watching if you just want to try the interface. See
[`docs/TRAINING.md`](docs/TRAINING.md) for both.

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
API pattern this repository's `syncfs.js` adapts). Not yet registered in the CoSE hub —
that's a Phase 4 (polish) step once there's a working live-loop demo to point to.
