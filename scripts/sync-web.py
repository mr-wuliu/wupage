#!/usr/bin/env python3
"""Sync wupage-web/index.html with the latest release.

Invoked by .github/workflows/sync-web.yml when a new release is published
on mr-wuliu/wupage. Updates all hardcoded version/asset references in the
target index.html so the marketing site stays in sync without client-side JS.

Targets (6 sites in index.html):
  - showcase section-desc:  "WuPage Translator vX.Y.Z ..."
  - install sidebar nav:    "GitHub 下载 <em>vX.Y.Z</em>"
  - install-github badge:   <span class="api-badge-brand">vX.Y.Z</span>
  - install-github step 1:  <code>wupage-X.Y.Z-edge.zip</code>（约 N KB）
  - install-github CTA:     href + "⬇ 下载 vX.Y.Z ZIP"
  - install-github notes:   href=".../releases/tag/vX.Y.Z"

Env vars (all required):
  NEW_TAG       e.g. "v0.1.2"
  NEW_ZIP_NAME  e.g. "wupage-0.1.2-edge.zip"
  NEW_ZIP_URL   full download URL (currently unused — derived from tag + name)
  NEW_ZIP_SIZE  human-readable e.g. "143 KB"
  TARGET_DIR    path to wupage-web checkout (relative to cwd)
"""
import os
import re
import sys
from pathlib import Path


def main() -> int:
    required = ('NEW_TAG', 'NEW_ZIP_NAME', 'NEW_ZIP_URL', 'NEW_ZIP_SIZE', 'TARGET_DIR')
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    new_tag = os.environ['NEW_TAG']
    new_zip_name = os.environ['NEW_ZIP_NAME']
    new_zip_size = os.environ['NEW_ZIP_SIZE']
    target_dir = Path(os.environ['TARGET_DIR'])
    index_path = target_dir / 'index.html'

    if not index_path.is_file():
        print(f"ERROR: {index_path} not found", file=sys.stderr)
        return 1

    content = index_path.read_text(encoding='utf-8')

    # Find current version (vX.Y.Z pattern, first occurrence in the file)
    match = re.search(r'\bv\d+\.\d+\.\d+\b', content)
    if not match:
        print("ERROR: could not find current vX.Y.Z pattern in index.html", file=sys.stderr)
        return 1
    old_tag = match.group(0)

    # Find current zip filename (wupage-X.Y.Z-anything.zip)
    zip_match = re.search(r'wupage-\d+\.\d+\.\d+-[^"\s<>]+\.zip', content)
    old_zip = zip_match.group(0) if zip_match else None

    # Find current size string ("约 N KB" / "约 N MB" / "约 N B")
    size_match = re.search(r'约\s*\d+(?:\.\d+)?\s*(?:B|KB|MB)', content)

    print(f"Old tag:  {old_tag}")
    print(f"New tag:  {new_tag}")
    if old_zip:
        print(f"Old zip:  {old_zip}")
    print(f"New zip:  {new_zip_name}")
    print(f"New size: {new_zip_size}")

    # Apply replacements in dependency-safe order:
    # 1. ZIP filename (most specific) first
    # 2. Size string
    # 3. URLs containing old tag
    # 4. Bare version references last (badges, labels)
    if old_zip:
        content = content.replace(old_zip, new_zip_name)

    if size_match:
        content = content.replace(size_match.group(0), f"约 {new_zip_size}")

    content = content.replace(f"releases/download/{old_tag}/", f"releases/download/{new_tag}/")
    content = content.replace(f"releases/tag/{old_tag}", f"releases/tag/{new_tag}")

    content = content.replace(old_tag, new_tag)

    index_path.write_text(content, encoding='utf-8')
    print(f"OK: updated {index_path}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
