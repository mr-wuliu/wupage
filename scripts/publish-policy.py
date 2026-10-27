"""Select automatic store submissions; manual store workflows bypass this policy."""

import re
import sys


def publish_stores(tag: str) -> bool:
    # Stable minor/major releases use x.y.0. Patch and prerelease builds stay
    # on GitHub unless explicitly submitted through a store's manual workflow.
    return re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.0", tag) is not None


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: publish-policy.py <release-tag>")
    print(f"publish_stores={str(publish_stores(sys.argv[1])).lower()}")
