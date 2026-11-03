#!/usr/bin/env python3
"""Sync wupage-web/index.html with the latest release.

Invoked by .github/workflows/sync-web.yml when a new release is published
on mr-wuliu/wupage. Updates all hardcoded version/asset references in the
target index.html so the marketing site stays in sync without client-side JS.
Sites using a releases/latest link without pinned versions need no rewrite.

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

Signed stable releases also supply NEW_CRX_NAME, NEW_CRX_SHA256,
NEW_CRX_SIZE and NEW_UPDATE_XML (the downloaded release XML path).
"""
import os
import re
import sys
import json
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

NAMESPACE = 'http://www.google.com/update2/response'


def chromium_update(target: Path) -> bytes | None:
    """Validate release metadata before allowing the stable site feed to change."""
    names = ('NEW_CRX_NAME', 'NEW_CRX_SHA256', 'NEW_CRX_SIZE', 'NEW_UPDATE_XML')
    if not any(os.environ.get(name) for name in names):
        return None  # Legacy releases can still sync their download links.
    if not all(os.environ.get(name) for name in names):
        raise ValueError('Incomplete signed Chromium release metadata.')
    tag = os.environ.get('NEW_TAG', '')
    if not re.fullmatch(r'v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)', tag):
        raise ValueError('Only stable releases may update the Chromium feed.')
    filename = f'wupage-{tag[1:]}-chromium.crx'
    digest = os.environ['NEW_CRX_SHA256']
    if os.environ['NEW_CRX_NAME'] != filename or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid Chromium asset name or SHA-256 digest.')
    config = json.loads((Path(__file__).resolve().parents[1] / 'build/chromium-signing.json').read_text(encoding='utf-8'))
    data = Path(os.environ['NEW_UPDATE_XML']).read_bytes()
    if len(data) > 16384:
        raise ValueError('Update XML is too large.')
    root = ET.fromstring(data)
    apps = root.findall(f'{{{NAMESPACE}}}app')
    if root.tag != f'{{{NAMESPACE}}}gupdate' or root.get('protocol') != '2.0' or len(apps) != 1:
        raise ValueError('Invalid update manifest structure.')
    checks = apps[0].findall(f'{{{NAMESPACE}}}updatecheck')
    if apps[0].get('appid') != config['extensionId'] or len(checks) != 1:
        raise ValueError('Update manifest has an unexpected Chromium identity.')
    check = checks[0]
    expected_url = f'https://github.com/mr-wuliu/wupage/releases/download/{tag}/{filename}'
    if check.get('version') != tag[1:] or check.get('codebase') != expected_url or check.get('hash_sha256') != digest:
        raise ValueError('Update manifest does not match the published CRX asset.')
    size = check.get('size', '')
    if not size.isascii() or not size.isdigit() or not 0 < int(size) < 10_000_000 or size != os.environ['NEW_CRX_SIZE']:
        raise ValueError('Invalid Chromium package size in update manifest.')
    existing = target / 'updates/chromium.xml'
    if existing.exists():
        old = ET.fromstring(existing.read_bytes()).find(f'{{{NAMESPACE}}}app/{{{NAMESPACE}}}updatecheck')
        if old is not None and old.get('version'):
            old_version = old.get('version')
            if not re.fullmatch(r'\d+\.\d+\.\d+', old_version):
                raise ValueError('Existing update feed contains an invalid version.')
            if tuple(map(int, old_version.split('.'))) > tuple(map(int, tag[1:].split('.'))):
                print(f'OK: stable Chromium feed already has newer version {old_version}; preserving it.')
                return None
    return data


class LatestReleaseLinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = False

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href') or ''
            if href.rstrip('/') == 'https://github.com/mr-wuliu/wupage/releases/latest':
                self.found = True


def sync_index() -> int:
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

    # A pinned ZIP still needs updating even if a latest-release link exists.
    zip_match = re.search(r'wupage-\d+\.\d+\.\d+-[^"\s<>]+\.zip', content)

    # Find current version (vX.Y.Z pattern, first occurrence in the file)
    match = re.search(r'\bv\d+\.\d+\.\d+\b', content)
    if not match:
        links = LatestReleaseLinkParser()
        links.feed(content)
        if links.found and not zip_match:
            print(f"OK: {index_path} already links to the latest release; no rewrite needed.")
            return 0
        print("ERROR: could not find current vX.Y.Z pattern in index.html", file=sys.stderr)
        return 1
    old_tag = match.group(0)

    # Find current zip filename (wupage-X.Y.Z-anything.zip)
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


def main() -> int:
    target = Path(os.environ.get('TARGET_DIR', '.'))
    try:
        update = chromium_update(target)
    except (ValueError, OSError, ET.ParseError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    result = sync_index()
    if result == 0 and update is not None:
        feed = target / 'updates/chromium.xml'
        feed.parent.mkdir(parents=True, exist_ok=True)
        feed.write_bytes(update)
        print(f'OK: updated {feed}')
    return result


if __name__ == '__main__':
    sys.exit(main())
