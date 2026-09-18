#!/usr/bin/env python3
"""Stub trainer for astroroot-painter Phase 1 — proves the File System Access +
protocol layer works BEFORE any real GPU/PyTorch trainer is involved (see the plan's
Phase 1 verification step). Deliberately does no machine learning: every instruction
gets a canned response after a short delay.

Replicates the real root_painter_trainer 0.3.0 behavior this client depends on
(see ../../docs/PROTOCOL.md, sourced from that package's actual code):
  - instruction filename is "{name}_{suffix}"; the name is recovered by stripping
    the LAST underscore-separated segment (fname.rpartition('_')[0])
  - valid names: start_training, segment, stop_training, trainer_status
  - success -> move to executed_instructions/; failure -> failed_instructions/ + a
    "{fname}_exception.txt" sibling
  - trainer_status.json is written only on demand, atomically (tmp + os.replace)

Usage:
    python3 fake_trainer.py --syncdir /path/to/mounted/folder
"""
import argparse
import json
import os
import shutil
import struct
import time
import zlib

REQUIRED_SUBDIRS = ["projects", "datasets", "instructions", "executed_instructions", "failed_instructions"]
VALID_NAMES = ["start_training", "segment", "stop_training", "trainer_status"]


def ensure_folders(sync_dir):
    for name in REQUIRED_SUBDIRS:
        os.makedirs(os.path.join(sync_dir, name), exist_ok=True)


def make_canned_png(w=64, h=64, rgba=(0, 255, 255, 178)):
    """Minimal stdlib-only PNG encoder — a flat-color square standing in for a real
    segmentation mask. Good enough to prove the round-trip; not a real prediction."""
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    row = bytes([0]) + bytes(rgba) * w
    raw = row * h
    idat = chunk(b"IDAT", zlib.compress(raw, 9))
    iend = chunk(b"IEND", b"")
    return sig + ihdr + idat + iend


def atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def handle(sync_dir, name, content, state):
    if name == "trainer_status":
        status = {"timestamp": time.time(), "training": state["training"]}
        if state["training"] and state.get("project"):
            status["project"] = state["project"]
        atomic_write_json(os.path.join(sync_dir, "trainer_status.json"), status)

    elif name == "start_training":
        state["training"] = True
        state["project"] = os.path.basename(os.path.dirname(content["model_dir"]))
        log_dir = os.path.join(sync_dir, content["log_dir"])
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, f"{time.strftime('%Y-%m-%d')}_train.csv")
        header_needed = not os.path.exists(log_path)
        with open(log_path, "a") as f:
            if header_needed:
                f.write("date_time,true_positives,false_positives,true_negatives,false_negatives,precision,recall,f1,defined,duration,loss\n")
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')},1,0,1,0,1.0,1.0,1.0,2,0.1,0.05\n")

    elif name == "stop_training":
        state["training"] = False

    elif name == "segment":
        seg_dir = os.path.join(sync_dir, content["seg_dir"])
        os.makedirs(seg_dir, exist_ok=True)
        png = make_canned_png()
        for fname in content["file_names"]:
            stem = os.path.splitext(fname)[0]
            with open(os.path.join(seg_dir, f"{stem}.png"), "wb") as f:
                f.write(png)


def main_loop(sync_dir):
    ensure_folders(sync_dir)
    instructions_dir = os.path.join(sync_dir, "instructions")
    executed_dir = os.path.join(sync_dir, "executed_instructions")
    failed_dir = os.path.join(sync_dir, "failed_instructions")
    # Real trainer clears instructions/ on startup — mirror that.
    for f in os.listdir(instructions_dir):
        os.remove(os.path.join(instructions_dir, f))

    state = {"training": False, "project": None}
    print(f"[fake_trainer] watching {instructions_dir}")
    while True:
        for fname in sorted(os.listdir(instructions_dir)):
            src = os.path.join(instructions_dir, fname)
            name = fname.rpartition("_")[0]
            try:
                with open(src) as f:
                    content = json.load(f)
                if name not in VALID_NAMES:
                    raise ValueError(f"unhandled instruction: {name}")
                time.sleep(0.3)  # simulate real turnaround, not instant
                handle(sync_dir, name, content, state)
                shutil.move(src, os.path.join(executed_dir, fname))
                print(f"[fake_trainer] executed {fname}")
            except Exception as e:  # noqa: BLE001 - stub: report, don't crash the loop
                shutil.move(src, os.path.join(failed_dir, fname))
                with open(os.path.join(failed_dir, f"{fname}_exception.txt"), "w") as f:
                    f.write(str(e))
                print(f"[fake_trainer] FAILED {fname}: {e}")
        time.sleep(0.5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--syncdir", required=True)
    args = parser.parse_args()
    main_loop(args.syncdir)
