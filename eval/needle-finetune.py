#!/usr/bin/env python
"""
Finetune Cactus Needle on this repo's corpus, without Needle's re-download.

Usage (from the needle checkout, with its venv python):
    NEEDLE_HOME=~/.local/share/cactus-needle \
    ./.venv/bin/python /path/to/budget/eval/needle-finetune.py \
        /path/to/budget/eval/needle-finetune.jsonl --epochs 8 --batch-size 8

## Why this wrapper exists

`needle finetune` calls `_resolve_checkpoint()`, which is documented as "always
downloading from HuggingFace to ensure freshness" and passes
`force_download=True`. That has two consequences worth avoiding:

  1. it DELETES the local `checkpoints/needle.pkl` and re-fetches ~52 MB on every
     single run, so an interrupted download leaves you with no base model at all;
  2. it goes through HF's Xet CDN, which failed here mid-transfer with
     `CAS Client Error: Request middleware error`, taking the whole job with it.

So this wrapper patches `_resolve_checkpoint` to a pass-through over a local file
and sets `HF_HUB_DISABLE_XET=1` for any download that does still happen. Nothing
in the vendored Needle checkout is modified.
"""
import argparse
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# Quieter XLA, and let JAX cache compiled kernels between runs.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", os.path.expanduser("~/.cache/jax"))

NEEDLE_HOME = os.environ.get("NEEDLE_HOME", os.path.expanduser("~/.local/share/cactus-needle"))
if NEEDLE_HOME not in sys.path:
    sys.path.insert(0, NEEDLE_HOME)

# Needle resolves `checkpoints/` and the tokenizer relative to the CWD.
os.chdir(NEEDLE_HOME)

from needle.training import finetune as ft  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl_path")
    ap.add_argument("--checkpoint", default="checkpoints/needle.pkl")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--checkpoint-dir", default="checkpoints")
    ap.add_argument("--cache-dir", default=None)
    args = ap.parse_args()

    if not os.path.exists(args.checkpoint):
        print(
            f"Base checkpoint missing: {args.checkpoint}\n"
            "Fetch it first (Xet disabled, because the CDN path is flaky):\n"
            "  HF_HUB_DISABLE_XET=1 python -c \"from huggingface_hub import hf_hub_download;"
            "hf_hub_download(repo_id='Cactus-Compute/needle',filename='needle.pkl',"
            "repo_type='model',local_dir='checkpoints')\"",
            file=sys.stderr,
        )
        return 2

    # The whole point of the wrapper: keep the local weights.
    ft._resolve_checkpoint = lambda path: path or args.checkpoint

    import jax

    print(f"jax backend : {jax.default_backend()}  devices={jax.devices()}", flush=True)
    print(f"corpus      : {args.jsonl_path}", flush=True)
    print(f"base ckpt   : {args.checkpoint}", flush=True)
    print(f"epochs      : {args.epochs}   batch: {args.batch_size}", flush=True)
    print("-" * 60, flush=True)

    ft.finetune_local(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
