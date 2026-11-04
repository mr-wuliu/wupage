import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from zipfile import ZipFile


spec = importlib.util.spec_from_file_location(
    'publish_edge', Path(__file__).resolve().parents[1] / 'scripts' / 'publish-edge.py'
)
publish_edge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish_edge)

PRODUCT_ID = '11111111-1111-1111-1111-111111111111'
UPLOAD_ID = '22222222-2222-2222-2222-222222222222'
SUBMIT_ID = '33333333-3333-3333-3333-333333333333'


class Response:
    def __init__(self, status=200, body=None, location=None):
        self.status = status
        self.headers = {} if location is None else {'Location': location}
        self.body = json.dumps(body).encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class PublishEdgeTests(unittest.TestCase):
    def setUp(self):
        self.package = Path('wupage-1.1.3-edge.zip')
        self.write_package()
        reader = patch.object(publish_edge.Path, 'read_bytes', side_effect=lambda: self.package_bytes)
        reader.start()
        self.addCleanup(reader.stop)
        self.client = publish_edge.EdgeClient(PRODUCT_ID, 'test-client', 'test-key')
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def write_package(self, version='1.1.3', manifest_path='manifest.json', **extra):
        buffer = io.BytesIO()
        with ZipFile(buffer, 'w') as archive:
            archive.writestr(manifest_path, json.dumps({'version': version, **extra}))
        self.package_bytes = buffer.getvalue()

    def test_upload_finishes_before_submission_and_uses_v11_authentication(self):
        responses = [
            Response(202, location=UPLOAD_ID),
            Response(body={'status': 'InProgress'}),
            Response(body={'status': 'Succeeded'}),
            Response(202, location=f'{self.client.base_url}/submissions/operations/{SUBMIT_ID}'),
            Response(body={'status': 'Succeeded'}),
        ]
        with patch.object(publish_edge, 'urlopen', side_effect=responses) as send, \
                patch.object(publish_edge.time, 'sleep'):
            publish_edge.publish_package(self.client, self.package, 'v1.1.3')
        requests = [call.args[0] for call in send.call_args_list]
        self.assertEqual([r.get_method() for r in requests], ['POST', 'GET', 'GET', 'POST', 'GET'])
        self.assertEqual(requests[0].data, self.package_bytes)
        self.assertEqual(requests[0].get_header('Content-type'), 'application/zip')
        for request in requests:
            self.assertEqual(request.get_header('Authorization'), 'ApiKey test-key')
            self.assertEqual(request.get_header('X-clientid'), 'test-client')
        self.assertEqual(requests[1].full_url, f'{self.client.base_url}/submissions/draft/package/operations/{UPLOAD_ID}')
        self.assertEqual(requests[3].full_url, f'{self.client.base_url}/submissions')
        self.assertEqual(requests[3].get_header('Content-type'), 'application/json')
        self.assertIn('v1.1.3', json.loads(requests[3].data)['notes'])

    def test_failed_upload_never_submits(self):
        responses = [Response(202, location=UPLOAD_ID), Response(body={
            'status': 'Failed', 'errorCode': 'InvalidPackage', 'message': 'Invalid ZIP',
        })]
        with patch.object(publish_edge, 'urlopen', side_effect=responses) as send:
            with self.assertRaisesRegex(RuntimeError, 'InvalidPackage'):
                publish_edge.publish_package(self.client, self.package, 'v1.1.3')
        self.assertEqual(send.call_count, 2)

    def test_failed_submission_is_reported(self):
        responses = [
            Response(202, location=UPLOAD_ID), Response(body={'status': 'Succeeded'}),
            Response(202, location=SUBMIT_ID),
            Response(body={'status': 'Failed', 'errorCode': 'InProgressSubmission'}),
        ]
        with patch.object(publish_edge, 'urlopen', side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, 'InProgressSubmission'):
                publish_edge.publish_package(self.client, self.package, 'v1.1.3')

    def test_invalid_release_packages_never_contact_the_api(self):
        cases = [
            ('v1.1.3-beta.1', '1.1.3', 'manifest.json', {}),
            ('v1.1.3', '1.1.2', 'manifest.json', {}),
            ('v1.1.3', '1.1.3', 'dist/manifest.json', {}),
            ('v1.1.3', '1.1.3', 'manifest.json', {'version_name': '1.1.3-beta.1'}),
            ('v1.1.3', '1.1.3', 'manifest.json', {'key': 'fixed-public-key'}),
            ('v1.1.3', '1.1.3', 'manifest.json', {'update_url': 'https://example.com/updates.xml'}),
        ]
        for tag, version, manifest_path, extra in cases:
            with self.subTest(tag=tag, version=version, path=manifest_path, extra=extra):
                self.write_package(version, manifest_path, **extra)
                with patch.object(publish_edge, 'urlopen') as send:
                    with self.assertRaises(ValueError):
                        publish_edge.publish_package(self.client, self.package, tag)
                    send.assert_not_called()

    def test_missing_operation_id_is_an_error(self):
        with patch.object(publish_edge, 'urlopen', return_value=Response(202)):
            with self.assertRaisesRegex(RuntimeError, 'invalid operation Location'):
                self.client.start_operation('/submissions', b'{}', 'application/json')

    def test_nested_manifests_are_rejected_before_upload(self):
        for name in ('pdf-fonts/manifest.json', 'assets/Manifest.JSON', 'assets\\manifest.json'):
            with self.subTest(name=name):
                self.write_package()
                buffer = io.BytesIO(self.package_bytes)
                with ZipFile(buffer, 'a') as archive:
                    archive.writestr(name, '{}')
                self.package_bytes = buffer.getvalue()
                with patch.object(publish_edge, 'urlopen') as send:
                    with self.assertRaisesRegex(ValueError, 'exactly one manifest.json'):
                        publish_edge.publish_package(self.client, self.package, 'v1.1.3')
                    send.assert_not_called()

    def test_font_provenance_metadata_is_allowed(self):
        buffer = io.BytesIO(self.package_bytes)
        with ZipFile(buffer, 'a') as archive:
            archive.writestr('pdf-fonts/font-metadata.json', '{}')
        publish_edge.validate_package(buffer.getvalue(), 'v1.1.3')

    def test_accepted_poll_responses_wait_for_success(self):
        empty = Response(202)
        empty.body = b''
        responses = [
            empty,
            Response(202, body={'status': 'InProgress'}),
            Response(202, body={'status': 'Succeeded'}),
        ]
        with patch.object(publish_edge, 'urlopen', side_effect=responses) as send, \
                patch.object(publish_edge.time, 'sleep') as sleep:
            self.client.wait_for_operation(f'/submissions/draft/package/operations/{UPLOAD_ID}')
        self.assertEqual(send.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_polling_times_out(self):
        with patch.object(publish_edge.time, 'monotonic', side_effect=[0, 0, 601]), \
                patch.object(publish_edge.time, 'sleep'), \
                patch.object(publish_edge, 'urlopen', return_value=Response(body={'status': 'InProgress'})):
            with self.assertRaisesRegex(TimeoutError, 'Partner Center'):
                self.client.wait_for_operation(f'/submissions/operations/{SUBMIT_ID}')


if __name__ == '__main__':
    unittest.main()
