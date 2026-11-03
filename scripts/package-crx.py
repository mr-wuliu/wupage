"""Package a self-hosted CRX3 and its stable update manifest using OpenSSL.

Format: https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto
Signing uses RSA PKCS#1 SHA-256, matching Chromium's crx_creator.cc.
No private material is stored in the source tree or published artifacts.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = 'http://www.google.com/update2/response'
MAX_SIZE = 10_000_000


def extension_id(public_key: bytes) -> str:
    return ''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(public_key).hexdigest()[:32])


def version_tuple(version: str) -> tuple[int, ...]:
    if not re.fullmatch(r'(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}', version):
        raise ValueError('Invalid Chromium version.')
    parts = tuple(map(int, version.split('.')))
    if max(parts) > 65535 or not any(parts):
        raise ValueError('Chromium version components must be 0–65535 and not all zero.')
    return parts + (0,) * (4 - len(parts))


def openssl_path() -> str:
    candidate = os.environ.get('OPENSSL') or shutil.which('openssl')
    if not candidate and os.name == 'nt':
        candidate = str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Git/usr/bin/openssl.exe')
    if not candidate or not Path(candidate).is_file():
        raise ValueError('OpenSSL is required; install it or set OPENSSL to its executable path.')
    return candidate


def openssl(*args: str, data: bytes | None = None) -> bytes:
    result = subprocess.run([openssl_path(), *args], input=data, capture_output=True)
    if result.returncode:
        # Never echo commands or OpenSSL diagnostics that could reveal key data.
        raise ValueError('OpenSSL could not read the signing key or complete the signature operation.')
    return result.stdout


def field(number: int, value: bytes) -> bytes:
    def varint(value: int) -> bytes:
        output = bytearray()
        while value > 127:
            output.append((value & 127) | 128)
            value >>= 7
        output.append(value)
        return bytes(output)
    return varint(number * 8 + 2) + varint(len(value)) + value


def crx3(archive: bytes, key: Path, public_key: bytes) -> bytes:
    signed_header = field(1, hashlib.sha256(public_key).digest()[:16])
    signed = b'CRX3 SignedData\0' + struct.pack('<I', len(signed_header)) + signed_header + archive
    signature = openssl('dgst', '-sha256', '-sign', str(key), data=signed)
    header = field(2, field(1, public_key) + field(2, signature)) + field(10000, signed_header)
    return b'Cr24' + struct.pack('<II', 3, len(header)) + header + archive


def update_xml(identity: str, version: str, url: str, crx: bytes) -> bytes:
    ET.register_namespace('', NAMESPACE)
    root = ET.Element(f'{{{NAMESPACE}}}gupdate', {'protocol': '2.0'})
    app = ET.SubElement(root, f'{{{NAMESPACE}}}app', {'appid': identity})
    ET.SubElement(app, f'{{{NAMESPACE}}}updatecheck', {
        'codebase': url, 'version': version, 'prodversionmin': '120.0.0.0',
        'hash_sha256': hashlib.sha256(crx).hexdigest(), 'size': str(len(crx)),
    })
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True) + b'\n'


def package(source: Path, output: Path, key: Path, tag: str, config: dict) -> Path:
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', tag):
        raise ValueError('Expected a v<semver> release tag.')
    public_key = openssl('pkey', '-in', str(key), '-pubout', '-outform', 'DER')
    if base64.b64encode(public_key).decode() != config['publicKey'] or extension_id(public_key) != config['extensionId']:
        raise ValueError('Signing key does not match the pinned Chromium identity.')
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    version_tuple(manifest['version'])
    if (manifest.get('version_name') or manifest['version']) != tag[1:]:
        raise ValueError('Release tag and manifest version do not match.')
    if manifest.get('browser_specific_settings') or 'service_worker' not in manifest.get('background', {}):
        raise ValueError('The signed package must use the Chromium build.')
    manifest.update(key=config['publicKey'], update_url=config['updateUrl'])
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
        for path in sorted(source.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlinks are not allowed in the signed package.')
            if not path.is_file():
                continue
            name = path.relative_to(source).as_posix()
            if path.suffix.lower() in ('.pem', '.key'):
                raise ValueError('Private key files must not be in the build directory.')
            if path.suffix.lower() == '.map':
                continue
            if path.name.lower() == 'manifest.json':
                if name != 'manifest.json':
                    raise ValueError('Only one root manifest.json is allowed.')
                zipped.writestr(name, json.dumps(manifest, indent=2) + '\n')
            else:
                zipped.write(path, name)
    data = crx3(archive.getvalue(), key, public_key)
    if len(data) >= MAX_SIZE:
        raise ValueError('The signed Chromium package must stay below 10 MB.')
    output.mkdir(parents=True, exist_ok=True)
    result = output / f'wupage-{tag[1:]}-chromium.crx'
    result.write_bytes(data)
    # Prereleases can be tested manually, but never advance the stable feed.
    feed = output / 'chromium.xml'
    if '-' not in tag:
        url = f'https://github.com/mr-wuliu/wupage/releases/download/{tag}/{result.name}'
        feed.write_bytes(update_xml(config['extensionId'], manifest['version'], url, data))
    elif feed.exists():
        feed.unlink()
    print(f'{result.name}: {len(data):,} bytes; ID {config["extensionId"]}; version {manifest["version"]}')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('dist'))
    parser.add_argument('--output', type=Path, default=Path('release'))
    parser.add_argument('--key', type=Path, help='Existing private key; otherwise use CRX_PRIVATE_KEY from the environment.')
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    config = json.loads((ROOT / 'build/chromium-signing.json').read_text(encoding='utf-8'))
    if args.key:
        package(args.source, args.output, args.key.resolve(), args.tag, config)
    else:
        secret = os.environ.pop('CRX_PRIVATE_KEY', '')
        if not secret:
            parser.error('CRX_PRIVATE_KEY is required; configure the release signing secret.')
        with tempfile.TemporaryDirectory(prefix='wupage-signing-') as directory:
            key = Path(directory) / 'signing.pem'
            key.write_text(secret, encoding='utf-8')
            key.chmod(0o600)
            package(args.source, args.output, key, args.tag, config)


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from None
