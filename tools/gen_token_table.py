#!/usr/bin/env python3
"""Regenerate the template-token table in README.md from formatter.TOKENS.

Dev-only: nothing here ships (package.json's `files` limits the bundle to
electron/** and app/**, and the Dockerfile copies app/ alone). Run it after
adding a token so the README cannot drift from the code:

    .venv/bin/python3 tools/gen_token_table.py --write
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.core.formatter import TOKENS   # noqa: E402

START = "<!-- tokens:start -->"
END = "<!-- tokens:end -->"

GROUPS = [
    ("all", "Every match"),
    ("series", "TV series"),
    ("video", "Video files"),
    ("movie", "Movies"),
    ("music", "Music"),
]


def render() -> str:
    lines = ["| Token | Meaning | Example |", "|---|---|---|"]
    for kind, label in GROUPS:
        rows = [t for t in TOKENS if t["kind"] == kind]
        if not rows:
            continue
        lines.append(f"| **{label}** | | |")
        for token in rows:
            lines.append(f"| `{token['name']}` | {token['description']} | `{token['example']}` |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true",
                        help="rewrite README.md in place instead of printing")
    args = parser.parse_args()

    table = render()
    if not args.write:
        print(table)
        return 0

    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    if START not in text or END not in text:
        print(f"{readme}: missing {START} / {END} markers", file=sys.stderr)
        return 1
    head, _, rest = text.partition(START)
    _, _, tail = rest.partition(END)
    readme.write_text(f"{head}{START}\n{table}\n{END}{tail}", encoding="utf-8")
    print(f"README.md updated ({len(TOKENS)} tokens)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
