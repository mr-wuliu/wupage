"""Create the Edge store ZIP from a Chromium release ZIP, without a fixed key."""
from __future__ import annotations

import argparse
import copy
import io
import json
from pathlib import Path
from zipfile import BadZipFile, ZipFile


def package_edge(source: Path, output: Path) -> Path:
    if source.resolve() == output.resolve():
        raise ValueError('The Edge ZIP must not overwrite its Chromium source.')
    buffer = io.BytesIO()
    with ZipFile(source) as original:
        members = original.infolist()
        manifests = [member.filename for member in members
                     if member.filename.replace('\\', '/').rsplit('/', 1)[-1].lower() == 'manifest.json']
        if manifests != ['manifest.json']:
            raise ValueError('The source ZIP must contain exactly one root manifest.json.')
        manifest = json.loads(original.read('manifest.json'))
        if (manifest.get('manifest_version') != 3
                or 'service_worker' not in manifest.get('background', {})
                or 'browser_specific_settings' in manifest):
            raise ValueError('The source ZIP must be a Chromium MV3 build.')
        # Edge assigns the store identity and manages store updates.
        manifest.pop('key', None)
        manifest.pop('update_url', None)
        with ZipFile(buffer, 'w') as packaged:
            for member in members:
                data = (json.dumps(manifest, indent=2) + '\n').encode('utf-8') \
                    if member.filename == 'manifest.json' else original.read(member)
                packaged.writestr(copy.copy(member), data)
    data = buffer.getvalue()
    if len(data) >= 10_000_000:
        raise ValueError('The Edge ZIP must stay below 10 MB.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = package_edge(args.source, args.output)
    except (ValueError, BadZipFile) as error:
        raise SystemExit(str(error)) from None
    print(f'{result.name}: {result.stat().st_size:,} bytes; Edge store manifest prepared.')
