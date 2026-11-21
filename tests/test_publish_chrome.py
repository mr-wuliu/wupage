import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    'publish_chrome', Path(__file__).resolve().parents[1] / 'scripts' / 'publish-chrome.py'
)
chrome = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(chrome)


def revision(state, version):
    return {'state': state, 'distributionChannels': [{'crxVersion': version}]}


class ChromePublishingTests(unittest.TestCase):
    def setUp(self):
        self.archive = Mock()
        self.archive.read_bytes.return_value = b'Chrome release ZIP'
        self.version = '1.24.1'
        self.status = {
            'itemId': chrome.ITEM_ID,
            'publishedItemRevisionStatus': revision('PUBLISHED', '1.23.1'),
        }
        self.store = Mock()
        self.store.status.return_value = self.status
        self.store.upload.return_value = {'uploadState': 'SUCCEEDED', 'crxVersion': self.version}
        self.store.publish.return_value = {'state': 'PENDING_REVIEW'}

    def test_sends_zip_and_submits_to_existing_item_for_normal_review(self):
        store = chrome.ChromeStore('publisher-123', 'test-token')
        with patch.object(chrome, 'request_json', side_effect=[
            self.status, self.store.upload.return_value, self.store.publish.return_value,
        ]) as request:
            self.assertEqual(chrome.submit(store, self.archive, self.version), 'submitted')

        item = f'publishers/publisher-123/items/{chrome.ITEM_ID}'
        requests = request.call_args_list
        self.assertEqual([call.args for call in requests], [
            (f'{chrome.STORE_API}/v2/{item}:fetchStatus', 'GET'),
            (f'{chrome.STORE_API}/upload/v2/{item}:upload', 'POST'),
            (f'{chrome.STORE_API}/v2/{item}:publish', 'POST'),
        ])
        self.assertEqual(requests[1].kwargs['data'], self.archive.read_bytes.return_value)
        self.assertEqual(requests[2].kwargs['data'], b'{}')
        self.assertTrue(all(call.kwargs['token'] == 'test-token' for call in requests))

    def test_checks_store_state_before_writing(self):
        cases = [
            ('already_published', '1.24.1.0', None),
            ('superseded', '1.30.0', None),
            ('already_submitted', '1.23.1', revision('PENDING_REVIEW', self.version)),
            ('staged', '1.23.1', revision('STAGED', self.version)),
            ('deferred', '1.23.1', revision('PENDING_REVIEW', '1.24.0')),
        ]
        for outcome, published, submitted in cases:
            with self.subTest(outcome=outcome):
                self.status['publishedItemRevisionStatus'] = revision('PUBLISHED', published)
                self.status['submittedItemRevisionStatus'] = submitted
                self.assertEqual(chrome.submit(self.store, self.archive, self.version), outcome)
        self.store.upload.assert_not_called()
        self.store.publish.assert_not_called()

    def test_waits_for_its_async_upload_to_finish(self):
        self.store.upload.return_value = {'uploadState': 'IN_PROGRESS'}
        self.store.status.side_effect = [
            self.status,
            dict(self.status, lastAsyncUploadState='IN_PROGRESS'),
            dict(self.status, lastAsyncUploadState='SUCCEEDED'),
        ]
        with patch.object(chrome.time, 'sleep'):
            self.assertEqual(chrome.submit(self.store, self.archive, self.version), 'submitted')
        self.store.upload.assert_called_once_with(self.archive)
        self.store.publish.assert_called_once_with()

    def test_leaves_an_existing_async_upload_alone(self):
        self.status['lastAsyncUploadState'] = 'IN_PROGRESS'
        self.assertEqual(chrome.submit(self.store, self.archive, self.version), 'deferred')
        self.store.upload.assert_not_called()
        self.store.publish.assert_not_called()

    def test_rejects_failed_uploads_and_mismatched_versions(self):
        cases = [
            ({'uploadState': 'FAILED'}, 'did not report success'),
            ({'uploadState': 'SUCCEEDED', 'crxVersion': '1.24.0'}, 'does not match'),
        ]
        for response, error in cases:
            with self.subTest(response=response):
                self.store.upload.return_value = response
                with self.assertRaisesRegex(ValueError, error):
                    chrome.submit(self.store, self.archive, self.version)
        self.store.publish.assert_not_called()

    def test_rejected_or_unpublished_items_require_dashboard_action(self):
        self.status['submittedItemRevisionStatus'] = revision('REJECTED', self.version)
        with self.assertRaisesRegex(ValueError, 'Resolve the existing Chrome submission'):
            chrome.submit(self.store, self.archive, self.version)
        self.status.pop('publishedItemRevisionStatus')
        with self.assertRaisesRegex(ValueError, 'Publish the first public version'):
            chrome.submit(self.store, self.archive, self.version)
        self.store.upload.assert_not_called()
        self.store.publish.assert_not_called()

    def test_dry_run_only_reads_store_status(self):
        self.assertEqual(chrome.submit(self.store, self.archive, self.version, dry_run=True), 'dry_run')
        self.store.status.assert_called_once_with()
        self.store.upload.assert_not_called()
        self.store.publish.assert_not_called()
