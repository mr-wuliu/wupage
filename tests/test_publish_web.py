import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'sync-web.py'
SPEC = importlib.util.spec_from_file_location('sync_web', SCRIPT)
sync_web = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync_web)


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


if __name__ == '__main__':
    unittest.main()
