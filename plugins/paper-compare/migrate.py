"""Migrate an idle paper library into its ForX profile, with a verified backup."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from storage import migrate

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    if args.home is None:
        checkout = Path(__file__).resolve().parents[2]
        if (checkout / "hermes_constants.py").is_file():
            sys.path.insert(0, str(checkout))
        from hermes_constants import get_hermes_home
        args.home = get_hermes_home()
    result = migrate(args.home, args.source)
    print(json.dumps({key: value for key, value in result.items() if key != "audit"}, ensure_ascii=False, indent=2))
