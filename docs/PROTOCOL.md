# RootPainter file-sync protocol (verified)

This documents the exact contract `astroroot-painter` builds against. Confirmed two ways:
(1) reading `root_painter_trainer` 0.3.0's actual installed source, (2) running the real
trainer against a throwaway sync dir on this machine and observing what it did.

RootPainter itself is never vendored into this repo. Install the trainer with:

```bash
pip install root-painter-trainer==0.3.0
start-trainer --syncdir /path/to/sync_dir
```

(Note: the PyPI package versions independently from the GitHub release tags on
[Abe404/root_painter](https://github.com/Abe404/root_painter) — `0.3.1` is a GitHub tag
only; PyPI's latest at time of writing is `0.3.0`. Check `pypi.org/pypi/root-painter-trainer/json`
before assuming a tag and a PyPI version match.)

`start-trainer --help` also documents `--maxbatchsize`.

## Sync directory layout

On startup the trainer creates exactly these 5 subfolders (verified by running it):

```
sync_dir/
├── projects/
├── datasets/
├── instructions/
├── executed_instructions/
└── failed_instructions/
```

**The trainer clears `instructions/` on every startup.** A client reconnecting to a
trainer that just restarted should not assume a previously-written instruction is still
pending.

## Instructions

One JSON file per instruction, written by the client into `instructions/`, named
`{name}_{hash(json.dumps(content))}`. The trainer's main loop picks it up, executes it,
then moves it to `executed_instructions/` (success) or, after 60 retries, to
`failed_instructions/` plus a sibling `{name}_{hash}_exception.txt`.

Only four instruction names are valid:

| Instruction | Fields | Effect |
|---|---|---|
| `start_training` | `model_dir, dataset_dir, train_annot_dir, val_annot_dir, seg_dir, log_dir, message_dir` | begins/resumes training on a project |
| `segment` | `dataset_dir, seg_dir, file_names, message_dir, model_dir` | runs inference on named files |
| `stop_training` | `message_dir` | stops the current training run |
| `trainer_status` | *(none)* | **writes/refreshes `sync_dir/trainer_status.json`** — see below |

All paths are written **relative to the sync dir** by the client and re-anchored to the
trainer's own local sync-dir root on read — this is what lets the trainer run on a
different machine (Colab+Drive, sshfs) than the client.

**`trainer_status.json` is written on demand, not spontaneously.** It only appears/updates
when the client sends a `trainer_status` instruction (confirmed by reading
`root_painter_trainer/trainer.py`'s `trainer_status()` method). A client that wants a live
"is it training" indicator must poll by sending this instruction periodically, not just
watch the file. Content: `{"timestamp": <float>, "training": <bool>, "project"?: <str>}`,
written atomically (`.tmp` + `os.replace`).

## Projects and datasets

Created **directly by the client**, not via an instruction:

```
projects/<name>/
├── <name>.seg_proj          # {name, dataset, original_model_file, location, file_names}
├── annotations/{train,val}/ # one RGBA PNG per source image
├── segmentations/
├── models/
├── messages/
└── logs/
```

`datasets/<name>/` is a flat folder of source images.

## Corrective annotations — the actual mechanic

One RGBA PNG per source image, same pixel dimensions as the photo:

- **Red channel > 0 → foreground (root)**
- **Green channel > 0 → background (soil)**
- **Unpainted pixels (R=G=0) are excluded from the loss entirely**

This is the whole trick: you only ever paint what the *current* model got wrong, not a
full mask. Live brush colors in the desktop client: foreground `rgba(255,0,0,180)`,
background `rgba(0,255,0,180)`, eraser fully transparent. Blue/alpha are cosmetic only.

**Landmine, confirmed by reading `trainer.py` and reproducing it live: training silently
never progresses past the initial random-weights checkpoint if `val_annot_dir` has zero
annotated images.**

```python
def train_one_epoch(self):
    ...
    if not [is_photo(a) for a in ls(train_annot_dir)]:
        return
    if not [is_photo(a) for a in ls(val_annot_dir)]:
        return          # <-- silent no-op. No exception, no message, no log line.
```

Reproduced directly: with only `train/` annotated, `start_training` was accepted
(`executed_instructions/`), the trainer sat at 0% CPU printing nothing beyond the
initial-checkpoint creation, and neither `messages/` nor `logs/` ever gained a new entry
— indistinguishable from "working but slow" unless you already know to check this.
Dropping one annotated image into `val/` while the trainer kept running (no restart
needed — it re-lists both directories every loop) made it start real training within
one poll cycle. **astroroot-painter's UI must not let a user hit this blind** — see
`app.js`'s `canStartTraining()`/annotation-count guard, added specifically for this.

## Model checkpoints

Plain `torch.save(state_dict())` of a custom `UNetGNRes` (Group-Norm residual U-Net),
named `<step>_<unix_timestamp>.pkl` in `projects/<name>/models/`. Output head:
`Conv2d(64, 2, kernel_size=1)` → **exactly 2 channels (background, foreground)**,
softmax @ 0.5. It's a **valid-convolution** network — output is smaller than input by a
fixed margin, tiled across arbitrary image sizes at inference — architecturally distinct
from astroroot's fixed-resize 6-channel RootNav2 ONNX model.

**No ONNX or TorchScript export exists anywhere in the RootPainter codebase** (confirmed:
three GitHub code searches for `onnx`/`torchscript`/`jit.trace` returned zero results). A
bridge into astroroot's shared viewer would need a new exporter written from scratch —
real work, out of scope for `astroroot-painter` v1.

## Segmentation output

Default is an RGBA PNG, cyan (`[0, 1.0, 1.0, 0.7]`) on transparent, at
`segmentations/<stem>.png`. `.npz` and RhizoVision-Explorer-style inverted B/W are
selectable alternates in the desktop client (not yet relevant here).

## Logs

Per-day CSV in `logs/`, header:
`date_time,true_positives,false_positives,true_negatives,false_negatives,precision,recall,f1,defined,duration,loss`.

## Verified on this machine (2026-09-17)

- `root-painter-trainer==0.3.0` installs cleanly via `uv pip install` on Python 3.11.
- `start-trainer --syncdir <path>` creates exactly the 5 folders above.
- `torch.backends.mps.is_available()` → `True` on this Mac (Apple Silicon) — local GPU
  training is viable without Colab, matching the earlier Tropism autodecoder precedent.
- Redirecting the trainer's stdout to a file shows nothing until the process is killed
  hard or exits on its own — Python fully-buffers stdout when it's not a TTY. Use
  `python -u` (or `PYTHONUNBUFFERED=1`) when debugging via a log file.
