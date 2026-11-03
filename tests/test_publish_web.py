import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'sync-web.py'
SPEC = importlib.util.spec_from_file_location('sync_web', SCRIPT)
sync_web = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync_web)
METADATA_SPEC = importlib.util.spec_from_file_location('prepare_web_sync', SCRIPT.with_name('prepare-web-sync.py'))
metadata = importlib.util.module_from_spec(METADATA_SPEC)
METADATA_SPEC.loader.exec_module(metadata)


class PublishWebTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.index = Path(directory.name) / 'index.html'
        environment = patch.dict(os.environ, {
            'NEW_TAG': 'v1.6.0',
            'NEW_ZIP_NAME': 'wupage-1.6.0-chrome.zip',
            'NEW_ZIP_URL': 'https://github.com/mr-wuliu/wupage/releases/download/v1.6.0/wupage-1.6.0-chrome.zip',
            'NEW_ZIP_SIZE': '5.6 MB',
            'TARGET_DIR': directory.name,
        })
        environment.start()
        self.addCleanup(environment.stop)

    def test_updates_legacy_version_download_size_and_notes(self):
        self.index.write_text('''<span>v1.5.5</span>
<a href="https://github.com/mr-wuliu/wupage/releases/download/v1.5.5/wupage-1.5.5-edge.zip">下载 v1.5.5</a>
<p>约 5.4 MB</p><a href="https://github.com/mr-wuliu/wupage/releases/tag/v1.5.5">更新日志</a>''', encoding='utf-8')
        self.assertEqual(sync_web.main(), 0)
        result = self.index.read_text(encoding='utf-8')
        self.assertNotIn('1.5.5', result)
        self.assertIn('releases/download/v1.6.0/wupage-1.6.0-chrome.zip', result)
        self.assertIn('releases/tag/v1.6.0', result)
        self.assertIn('约 5.6 MB', result)

    def test_latest_release_link_succeeds_without_rewriting_the_page(self):
        for href in ('https://github.com/mr-wuliu/wupage/releases/latest',
                     'https://github.com/mr-wuliu/wupage/releases/latest/'):
            with self.subTest(href=href):
                original = f'<article id="install-github"><a href="{href}">下载最新版本</a></article>\r\n'.encode('utf-8')
                self.index.write_bytes(original)
                self.assertEqual(sync_web.main(), 0)
                self.assertEqual(self.index.read_bytes(), original)

    def test_unknown_page_does_not_silently_skip_sync(self):
        self.index.write_text('<a href="https://example.com/releases/latest">Download</a>', encoding='utf-8')
        self.assertEqual(sync_web.main(), 1)

    def test_latest_link_does_not_hide_an_unversioned_page_with_a_stale_zip(self):
        self.index.write_text('''<a href="https://github.com/mr-wuliu/wupage/releases/latest">Latest</a>
<code>wupage-1.5.5-edge.zip</code>''', encoding='utf-8')
        self.assertEqual(sync_web.main(), 1)

    def test_commented_latest_link_does_not_count_as_a_download_entry(self):
        self.index.write_text('<!-- <a href="https://github.com/mr-wuliu/wupage/releases/latest">Latest</a> -->', encoding='utf-8')
        self.assertEqual(sync_web.main(), 1)

    def signed_update(self, version='1.6.0'):
        config = json.loads((SCRIPT.parents[1] / 'build/chromium-signing.json').read_text(encoding='utf-8'))
        self.index.write_text('<a href="https://github.com/mr-wuliu/wupage/releases/latest">Latest</a>', encoding='utf-8')
        xml = self.index.parent / 'release.xml'
        xml.write_text(f'''<?xml version="1.0"?>
<gupdate xmlns="{sync_web.NAMESPACE}" protocol="2.0">
  <app appid="{config['extensionId']}"><updatecheck version="{version}"
    codebase="https://github.com/mr-wuliu/wupage/releases/download/v{version}/wupage-{version}-chromium.crx"
    hash_sha256="{'a' * 64}" size="1234" /></app>
</gupdate>''', encoding='utf-8')
        environment = patch.dict(os.environ, {
            'NEW_TAG': f'v{version}', 'NEW_CRX_NAME': f'wupage-{version}-chromium.crx',
            'NEW_CRX_SHA256': 'a' * 64, 'NEW_CRX_SIZE': '1234', 'NEW_UPDATE_XML': str(xml),
        })
        environment.start()
        self.addCleanup(environment.stop)
        return xml

    def test_signed_feed_is_written_even_when_latest_html_needs_no_rewrite(self):
        xml = self.signed_update()
        self.assertEqual(sync_web.main(), 0)
        self.assertEqual((self.index.parent / 'updates/chromium.xml').read_bytes(), xml.read_bytes())

    def test_old_release_cannot_roll_back_the_existing_feed(self):
        self.signed_update('1.10.0')
        self.assertEqual(sync_web.main(), 0)
        feed = self.index.parent / 'updates/chromium.xml'
        before = feed.read_bytes()
        self.signed_update('1.9.9')
        self.assertEqual(sync_web.main(), 0)
        self.assertEqual(feed.read_bytes(), before)

    def test_foreign_id_url_version_digest_and_size_cannot_change_the_site(self):
        for attribute, value in (('appid', 'a' * 32), ('codebase', 'https://example.com/test.crx'),
                                 ('version', '9.9.9'), ('hash_sha256', 'b' * 64), ('size', '10000000'), ('size', '1233')):
            with self.subTest(attribute=attribute):
                xml = self.signed_update()
                root = ET.fromstring(xml.read_bytes())
                node = root.find(f'{{{sync_web.NAMESPACE}}}app')
                if attribute != 'appid':
                    node = node.find(f'{{{sync_web.NAMESPACE}}}updatecheck')
                node.set(attribute, value)
                xml.write_bytes(ET.tostring(root))
                before = self.index.read_bytes()
                self.assertEqual(sync_web.main(), 1)
                self.assertEqual(self.index.read_bytes(), before)
                self.assertFalse((self.index.parent / 'updates/chromium.xml').exists())

    def test_prerelease_and_incomplete_metadata_cannot_advance_feed(self):
        self.signed_update()
        with patch.dict(os.environ, {'NEW_TAG': 'v1.7.0-beta.1'}):
            self.assertEqual(sync_web.main(), 1)
        with patch.dict(os.environ, {'NEW_CRX_SHA256': ''}):
            self.assertEqual(sync_web.main(), 1)

    def test_initial_noupdate_feed_can_be_replaced_by_the_first_signed_release(self):
        xml = self.signed_update()
        feed = self.index.parent / 'updates/chromium.xml'
        feed.parent.mkdir()
        feed.write_text(f'<gupdate xmlns="{sync_web.NAMESPACE}" protocol="2.0"><app><updatecheck status="noupdate" /></app></gupdate>')
        self.assertEqual(sync_web.main(), 0)
        self.assertEqual(feed.read_bytes(), xml.read_bytes())


class ReleaseMetadataTests(unittest.TestCase):
    def release(self):
        return {'tag_name': 'v1.6.0', 'prerelease': False, 'draft': False, 'assets': [
            {'name': 'wupage-1.6.0-firefox-source.zip', 'size': 20000000},
            {'name': 'wupage-1.6.0-chrome.zip', 'size': 5600000},
            {'name': 'wupage-1.6.0-chromium.crx', 'size': 5601000, 'digest': 'sha256:' + 'a' * 64},
            {'name': 'chromium.xml', 'size': 512},
        ]}

    def test_selects_browser_zip_and_github_crx_digest(self):
        outputs = metadata.release_outputs('v1.6.0', self.release())
        self.assertEqual(outputs['tag'], 'v1.6.0')
        self.assertEqual(outputs['zip_name'], 'wupage-1.6.0-chrome.zip')
        self.assertEqual(outputs['zip_size'], '5.3 MB')
        self.assertEqual(outputs['crx_sha256'], 'a' * 64)

    def test_draft_and_prerelease_do_not_sync_public_channels(self):
        for flag in ('draft', 'prerelease'):
            release = self.release()
            release[flag] = True
            self.assertEqual(metadata.release_outputs('v1.6.0', release), {})
        self.assertEqual(metadata.release_outputs('v1.7.0-beta.1', {'tag_name': 'v1.7.0-beta.1'}), {})

    def test_legacy_release_preserves_existing_feed(self):
        release = self.release()
        release['assets'] = release['assets'][:2]
        outputs = metadata.release_outputs('v1.6.0', release)
        self.assertEqual(outputs['sync'], 'true')
        self.assertNotIn('crx_name', outputs)

    def test_incomplete_assets_digest_and_tag_mismatch_are_rejected(self):
        release = self.release()
        release['assets'].pop()
        with self.assertRaises(ValueError):
            metadata.release_outputs('v1.6.0', release)
        release = self.release()
        release['assets'][2]['digest'] = ''
        with self.assertRaises(ValueError):
            metadata.release_outputs('v1.6.0', release)
        with self.assertRaises(ValueError):
            metadata.release_outputs('v1.6.1', self.release())


if __name__ == '__main__':
    unittest.main()
