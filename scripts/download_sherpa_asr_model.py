#!/usr/bin/env python3
"""Download the bilingual streaming Paraformer model used by ASR_PROVIDER=sherpa_onnx."""

from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    f"{MODEL_NAME}.tar.bz2"
)


def _download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url}")
    with urllib.request.urlopen(url) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        default=f"models/{MODEL_NAME}",
        help="Directory that will contain encoder/decoder/tokens",
    )
    parser.add_argument("--force", action="store_true", help="Re-download even if present")
    args = parser.parse_args(argv)

    target = Path(args.dir).expanduser()
    if not target.is_absolute():
        target = Path.cwd() / target
    encoder = target / "encoder.int8.onnx"
    decoder = target / "decoder.int8.onnx"
    tokens = target / "tokens.txt"
    if encoder.is_file() and decoder.is_file() and tokens.is_file() and not args.force:
        print(f"Model already present: {target}")
        return 0

    with tempfile.TemporaryDirectory(prefix="sherpa-asr-") as tmp:
        archive = Path(tmp) / f"{MODEL_NAME}.tar.bz2"
        _download(MODEL_URL, archive)
        print(f"Extracting {archive.name}")
        with tarfile.open(archive, "r:bz2") as tar:
            tar.extractall(path=tmp)
        extracted = Path(tmp) / MODEL_NAME
        if not extracted.is_dir():
            print(f"Archive did not contain {MODEL_NAME}/", file=sys.stderr)
            return 1
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(extracted), str(target))

    missing = [path.name for path in (encoder, decoder, tokens) if not path.is_file()]
    if missing:
        print(f"Extracted model is incomplete, missing: {', '.join(missing)}", file=sys.stderr)
        return 1
    print(f"Ready: {target}")
    print('Then: export ASR_PROVIDER=sherpa_onnx && pip install -e ".[sherpa]"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
