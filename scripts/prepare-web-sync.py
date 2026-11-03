"""Read a published stable release and select verified website sync metadata."""
import argparse
import json
import os
import re
import subprocess


def release_outputs(tag: str, data: dict) -> dict[str, str]:
    if not re.fullmatch(r'v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?', tag):
        raise ValueError('Expected a v<semver> release tag.')
    if data.get('tag_name') != tag:
        raise ValueError('GitHub returned a different release tag.')
    if data.get('prerelease') or data.get('draft') or '-' in tag:
        return {}  # Public website and automatic updates follow stable releases.
    assets = data.get('assets') or []
    def asset(name):
        matches = [item for item in assets if item.get('name') == name]
        if len(matches) > 1:
            raise ValueError(f'Duplicate release asset: {name}')
        return matches[0] if matches else None
    zip_name = f'wupage-{tag[1:]}-chrome.zip'
    zipped = asset(zip_name)
    if not zipped:
        raise ValueError(f'Missing Chrome ZIP in release {tag}.')
    size = int(zipped.get('size') or 0)
    if not 0 < size < 10_000_000:
        raise ValueError('Invalid Chrome ZIP size.')
    size_text = f'{size} B' if size < 1024 else f'{round(size / 1024)} KB' if size < 1024 * 1024 else f'{size / 1024 / 1024:.1f} MB'
    outputs = {'sync': 'true', 'tag': tag, 'zip_name': zip_name,
               'zip_url': f'https://github.com/mr-wuliu/wupage/releases/download/{tag}/{zip_name}', 'zip_size': size_text}
    crx_name = f'wupage-{tag[1:]}-chromium.crx'
    crx, xml = asset(crx_name), asset('chromium.xml')
    if bool(crx) != bool(xml):
        raise ValueError('Signed stable releases must include both the CRX and chromium.xml.')
    if crx:
        digest = crx.get('digest') or ''
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise ValueError('The Chromium asset is missing a valid GitHub SHA-256 digest.')
        if not 0 < int(crx.get('size') or 0) < 10_000_000:
            raise ValueError('Invalid Chromium asset size.')
        outputs.update(crx_name=crx_name, crx_sha256=digest[7:], crx_size=str(crx['size']))
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    args = parser.parse_args()
    result = subprocess.run(['gh', 'api', f'repos/mr-wuliu/wupage/releases/tags/{args.tag}'],
                            capture_output=True, text=True, check=True)
    outputs = release_outputs(args.tag, json.loads(result.stdout))
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
        for key, value in outputs.items():
            stream.write(f'{key}={value}\n')
    print(f'{args.tag}: website sync prepared.' if outputs else 'Draft or prerelease: skipping website and stable update feed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
