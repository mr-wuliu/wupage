import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


SPEC = importlib.util.spec_from_file_location(
    'package_edge', Path(__file__).resolve().parents[1] / 'scripts' / 'package-edge.py'
)
package_edge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package_edge)


class EdgePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.source = Path(temporary.name) / 'chrome.zip'
        self.output = Path(temporary.name) / 'release' / 'edge.zip'
        self.manifest = {
            'manifest_version': 3,
            'version': '1.7.0',
            'background': {'service_worker': 'background.js', 'type': 'module'},
            'key': 'fixed-public-key',
            'update_url': 'https://example.com/updates.xml',
            'permissions': ['storage'],
        }

    def write_source(self, extra_manifest=None):
        with ZipFile(self.source, 'w', ZIP_DEFLATED) as archive:
            archive.writestr('manifest.json', json.dumps(self.manifest))
            script = ZipInfo('background.js', date_time=(2026, 11, 4, 1, 2, 4))
            script.compress_type = ZIP_DEFLATED
            script.external_attr = 0o100644 << 16
            archive.writestr(script, b'console.log("runtime unchanged");\n')
            archive.writestr('assets/runtime.wasm', bytes(range(256)))
            if extra_manifest:
                archive.writestr(extra_manifest, '{}')

    def test_store_manifest_omits_identity_fields_and_preserves_runtime(self):
        self.write_source()
        original_bytes = self.source.read_bytes()
        package_edge.package_edge(self.source, self.output)
        self.assertEqual(self.source.read_bytes(), original_bytes)
        with ZipFile(self.source) as source, ZipFile(self.output) as output:
            self.assertIsNone(output.testzip())
            self.assertEqual(output.namelist(), source.namelist())
            expected = {key: value for key, value in self.manifest.items()
                        if key not in ('key', 'update_url')}
            self.assertEqual(json.loads(output.read('manifest.json')), expected)
            for name in ('background.js', 'assets/runtime.wasm'):
                self.assertEqual(output.read(name), source.read(name))
                for attribute in ('date_time', 'compress_type', 'external_attr'):
                    self.assertEqual(getattr(output.getinfo(name), attribute),
                                     getattr(source.getinfo(name), attribute))

    def test_already_store_compatible_manifest_is_preserved(self):
        del self.manifest['key']
        del self.manifest['update_url']
        self.write_source()
        package_edge.package_edge(self.source, self.output)
        with ZipFile(self.output) as output:
            self.assertEqual(json.loads(output.read('manifest.json')), self.manifest)

    def test_nested_or_case_variant_manifests_are_rejected(self):
        for name in ('assets/manifest.json', 'assets/Manifest.JSON', 'assets\\manifest.json'):
            with self.subTest(name=name):
                self.write_source(name)
                with self.assertRaisesRegex(ValueError, 'exactly one root manifest'):
                    package_edge.package_edge(self.source, self.output)
                self.assertFalse(self.output.exists())

    def test_firefox_package_is_rejected(self):
        self.manifest['background'] = {'scripts': ['background.js']}
        self.manifest['browser_specific_settings'] = {'gecko': {'id': 'test@example.com'}}
        self.write_source()
        with self.assertRaisesRegex(ValueError, 'Chromium MV3'):
            package_edge.package_edge(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_source_cannot_be_overwritten(self):
        self.write_source()
        original_bytes = self.source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'must not overwrite'):
            package_edge.package_edge(self.source, self.source)
        self.assertEqual(self.source.read_bytes(), original_bytes)


if __name__ == '__main__':
    unittest.main()
