"""Atomically restore the model manifest saved before the last promotion."""

import argparse
import os
from pathlib import Path
import tempfile


def rollback(output: Path) -> None:
    previous = output.with_suffix(output.suffix + ".previous")
    if not previous.is_file():
        raise FileNotFoundError(f"No rollback artifact exists for {output}")
    with tempfile.NamedTemporaryFile("wb", dir=output.parent, delete=False) as handle:
        handle.write(previous.read_bytes())
        handle.flush()
        os.fsync(handle.fileno())
        temporary = handle.name
    os.replace(temporary, output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    args = parser.parse_args()
    rollback(Path(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
