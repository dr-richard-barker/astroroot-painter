# Running the trainer

astroroot-painter is a browser client only. It never runs any machine learning itself —
it reads and writes plain files in a folder that a real RootPainter trainer process also
watches. You need that trainer running somewhere before the "Start training" / "Segment"
buttons do anything.

## Option A — on your own Mac or Linux box with a GPU

Verified working on this basis (2026-09-17): Apple Silicon via PyTorch's MPS backend.

```bash
python3 -m venv rp-env && source rp-env/bin/activate
pip install root-painter-trainer==0.3.0
start-trainer --syncdir ~/root_painter_sync
```

`start-trainer --syncdir <path>` creates the folder and its 5 required subfolders on
first run (`projects/`, `datasets/`, `instructions/`, `executed_instructions/`,
`failed_instructions/`) — confirmed by actually running it. Requirements: an NVIDIA GPU
with 8GB+ VRAM, or Apple Silicon (checked with `python3 -c "import torch;
print(torch.backends.mps.is_available())"` — should print `True`).

Then, in astroroot-painter, click **Mount sync folder…** and pick the exact same folder
(`~/root_painter_sync` in the example above).

## Option B — Google Colab (no local GPU)

Follow RootPainter's own [Colab tutorial](https://colab.research.google.com/drive/104narYAvTBt-X4QEDrBSOZm_DRaAKHtA)
to mount Google Drive and start the trainer there. Then install Google Drive's desktop
sync app (or `rclone`) so the same folder appears on your local disk, and mount *that*
local folder in astroroot-painter — the trainer doesn't need to know or care that its
sync directory is being mirrored to Drive underneath it.

## Option C — a stub trainer, for trying the interface with no ML at all

`scripts/fake-syncdir/fake_trainer.py` implements just enough of the protocol (folder
creation, instruction pickup/execution, a canned segmentation PNG, a fake training log
row) to exercise every button in the UI without installing PyTorch or using a GPU. It is
not RootPainter and produces no real predictions — it exists purely to test this
repository's own File System Access + protocol code in isolation, which is how it was
verified during development (see docs/PROTOCOL.md's "Verified on this machine" section).

```bash
python3 scripts/fake-syncdir/fake_trainer.py --syncdir /tmp/rp_test_sync
```

Then mount `/tmp/rp_test_sync` in the browser and try Start training / Segment / Check
status — each should log `executed` within a couple of seconds.

## Browser requirement

Mounting a folder uses the File System Access API, which today means **Chrome or Edge
86+**. Firefox and Safari do not support it; there is no live-loop fallback for them in
this version.
