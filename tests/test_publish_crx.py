import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/package-crx.py'
SPEC = importlib.util.spec_from_file_location('package_crx', SCRIPT)
crx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(crx)


def fields(data):
    """Independent protobuf reader for CRX3's length-delimited fields."""
    offset = 0
    def varint():
        nonlocal offset
        value, shift = 0, 0
        while True:
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7
    result = {}
    while offset < len(data):
        tag = varint()
        if tag & 7 != 2:
            raise AssertionError('Unexpected protobuf wire type')
        length = varint()
        result[tag >> 3] = data[offset:offset + length]
        offset += length
    return result


class PublishCrxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.key = Path(cls.directory.name) / 'test.pem'
        crx.openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', str(cls.key))
        cls.public_key = crx.openssl('pkey', '-in', str(cls.key), '-pubout', '-outform', 'DER')
        cls.config = {
            'publicKey': base64.b64encode(cls.public_key).decode(),
            'extensionId': crx.extension_id(cls.public_key),
            'updateUrl': 'https://wupage.mrwuliu.top/updates/chromium.xml',
        }

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / 'dist'
        self.source.mkdir()
        self.output = self.root / 'release'
        self.manifest = {'manifest_version': 3, 'name': 'Test', 'version': '1.6.2',
                         'background': {'service_worker': 'background.js'}}
        self.write_manifest()
        (self.source / 'background.js').write_text('console.log("fixture");')
        (self.source / 'background.js.map').write_text('{}')

    def write_manifest(self):
        (self.source / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def package(self, tag='v1.6.2', config=None):
        return crx.package(self.source, self.output, self.key, tag, config or self.config)

    def test_real_crx_signature_zip_boundaries_and_update_feed_agree(self):
        before = (self.source / 'manifest.json').read_bytes()
        data = self.package().read_bytes()
        magic, version, size = struct.unpack('<4sII', data[:12])
        self.assertEqual((magic, version), (b'Cr24', 3))
        header = fields(data[12:12 + size])
        proof = fields(header[2])
        self.assertEqual(proof[1], self.public_key)
        self.assertEqual(crx.extension_id(proof[1]), self.config['extensionId'])
        self.assertEqual(fields(header[10000])[1], hashlib.sha256(self.public_key).digest()[:16])
        archive = data[12 + size:]
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            self.assertEqual(sorted(zipped.namelist()), ['background.js', 'manifest.json'])
            manifest = json.loads(zipped.read('manifest.json'))
            self.assertEqual(manifest['key'], self.config['publicKey'])
            self.assertEqual(manifest['update_url'], self.config['updateUrl'])
        self.assertEqual((self.source / 'manifest.json').read_bytes(), before)
        signed = b'CRX3 SignedData\0' + struct.pack('<I', len(header[10000])) + header[10000] + archive
        public = self.root / 'public.pem'
        public.write_bytes(crx.openssl('pkey', '-in', str(self.key), '-pubout'))
        signature = self.root / 'signature'
        signature.write_bytes(proof[2])
        self.assertIn(b'Verified OK', crx.openssl('dgst', '-sha256', '-verify', str(public), '-signature', str(signature), data=signed))
        with self.assertRaises(ValueError):
            crx.openssl('dgst', '-sha256', '-verify', str(public), '-signature', str(signature), data=signed + b'tamper')
        check = ET.parse(self.output / 'chromium.xml').getroot().find(f'{{{crx.NAMESPACE}}}app/{{{crx.NAMESPACE}}}updatecheck')
        self.assertEqual(check.get('version'), '1.6.2')
        self.assertEqual(check.get('size'), str(len(data)))
        self.assertTrue(check.get('codebase').endswith('/v1.6.2/wupage-1.6.2-chromium.crx'))
        self.assertEqual(check.get('hash_sha256'), hashlib.sha256(data).hexdigest())

    def test_prerelease_uses_numeric_version_without_publishing_a_stable_feed(self):
        self.manifest.update(version='1.7.0.1', version_name='1.7.0-beta.1')
        self.write_manifest()
        self.output.mkdir()
        (self.output / 'chromium.xml').write_text('stale')
        self.assertTrue(self.package('v1.7.0-beta.1').exists())
        self.assertFalse((self.output / 'chromium.xml').exists())

    def test_wrong_signing_key_fails_before_writing_release_files(self):
        with self.assertRaisesRegex(ValueError, 'pinned Chromium identity'):
            self.package(config={**self.config, 'extensionId': 'a' * 32})
        self.assertFalse(self.output.exists())

    def test_nested_manifest_and_private_keys_are_rejected(self):
        for name in ('assets/manifest.json', 'secret.pem', 'secret.key'):
            with self.subTest(name=name):
                path = self.source / name
                path.parent.mkdir(exist_ok=True)
                path.write_text('{}')
                with self.assertRaises(ValueError):
                    self.package()
                path.unlink()
        self.assertFalse(self.output.exists())

    def test_tag_mismatch_and_firefox_source_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'do not match'):
            self.package('v1.6.3')
        self.manifest['background'] = {'scripts': ['background.js']}
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'Chromium build'):
            self.package()

    def test_invalid_chromium_versions(self):
        for version in ('0.0.0', '1.65536.0', '1.02.3', '1.2.3-beta.1', '1.2.3.4.5'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                crx.version_tuple(version)


if __name__ == '__main__':
    unittest.main()
