import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
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
        self.output = io.StringIO()
        output = contextlib.redirect_stdout(self.output)
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def write_package(self, version='1.1.3', manifest_path='manifest.json', **extra):
        buffer = io.BytesIO()
        with ZipFile(buffer, 'w') as archive:
            archive.writestr(manifest_path, json.dumps({'version': version, **extra}))
        self.package_bytes = buffer.getvalue()

    @contextlib.contextmanager
    def action_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            result = Path(directory) / 'output.txt'
            summary = Path(directory) / 'summary.md'
            environment = {
                'EDGE_PRODUCT_ID': PRODUCT_ID,
                'EDGE_CLIENT_ID': 'test-client',
                'EDGE_API_KEY': 'test-key',
                'RELEASE_TAG': 'v1.1.3',
                'GITHUB_OUTPUT': str(result),
                'GITHUB_STEP_SUMMARY': str(summary),
            }
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(publish_edge.sys, 'argv', ['publish-edge.py', str(self.package)]):
                yield result, summary

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
            result = publish_edge.publish_package(self.client, self.package, 'v1.1.3')
        self.assertEqual(result, 'submitted')
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

    def test_action_distinguishes_submitted_from_deferred_without_retrying(self):
        cases = [
            ({'status': 'Succeeded'}, 'submitted'),
            ({'status': 'Failed', 'errorCode': 'InProgressSubmission',
              'message': "Can't publish extension as your extension submission is in progress. "
                         'Please try again later.'}, 'deferred'),
        ]
        for terminal_result, expected in cases:
            with self.subTest(expected=expected), self.action_environment() as (result, summary):
                self.output.seek(0)
                self.output.truncate()
                responses = [
                    Response(202, location=UPLOAD_ID), Response(body={'status': 'Succeeded'}),
                    Response(202, location=SUBMIT_ID), Response(body=terminal_result),
                ]
                with patch.object(publish_edge, 'urlopen', side_effect=responses) as send, \
                        patch.object(publish_edge.time, 'sleep') as sleep:
                    publish_edge.main()
                self.assertEqual(send.call_count, 4)
                sleep.assert_not_called()
                self.assertEqual(result.read_text(encoding='utf-8'), f'submission_status={expected}\n')
                text = summary.read_text(encoding='utf-8')
                self.assertIn('v1.1.3', text)
                if expected == 'deferred':
                    self.assertIn('NOT submitted for certification', text)
                    self.assertIn('InProgressSubmission', text)
                    self.assertIn('No automatic retry or cancellation', text)
                    self.assertIn('::warning::', self.output.getvalue())
                    self.assertNotIn('submitted successfully', self.output.getvalue())
                else:
                    self.assertIn('submitted for certification', text)
                    self.assertNotIn('::warning::', self.output.getvalue())

    def test_upload_blocked_by_existing_submission_never_submits(self):
        responses = [Response(202, location=UPLOAD_ID), Response(body={
            'status': 'Failed', 'errorCode': 'InProgressSubmission',
        })]
        with patch.object(publish_edge, 'urlopen', side_effect=responses) as send:
            result = publish_edge.publish_package(self.client, self.package, 'v1.1.3')
        self.assertEqual(result, 'deferred')
        self.assertEqual(send.call_count, 2)

    def test_other_operation_failures_remain_errors_without_success_outputs(self):
        cases = [
            # The generic upload failure observed in v1.21.0 is still an error.
            {'status': 'Failed', 'message': 'An error occurred while performing the operation',
             'errorCode': None, 'errors': None},
            {'status': 'Failed', 'errorCode': 'InvalidPackage'},
            {'status': 'Failed', 'message': 'InProgressSubmission'},
            {'status': 'Failed', 'errorCode': 'inprogresssubmission'},
            {'status': 'Cancelled', 'errorCode': 'InProgressSubmission'},
            {'errorCode': 'InProgressSubmission'},
        ]
        for terminal_result in cases:
            for stage in ('upload', 'submission'):
                with self.subTest(result=terminal_result, stage=stage), \
                        self.action_environment() as (result, summary):
                    responses = []
                    if stage == 'submission':
                        responses.extend([
                            Response(202, location=UPLOAD_ID), Response(body={'status': 'Succeeded'}),
                        ])
                    responses.extend([Response(202, location=SUBMIT_ID), Response(body=terminal_result)])
                    with patch.object(publish_edge, 'urlopen', side_effect=responses) as send:
                        with self.assertRaises(publish_edge.EdgeOperationError):
                            publish_edge.main()
                    self.assertEqual(send.call_count, len(responses))
                    self.assertFalse(result.exists())
                    self.assertFalse(summary.exists())

    def test_http_and_network_errors_are_not_deferred_or_retried(self):
        cases = [
            HTTPError(self.client.base_url, 401, 'Unauthorized', {}, io.BytesIO(b'expired key')),
            HTTPError(self.client.base_url, 409, 'Conflict', {}, io.BytesIO(b'InProgressSubmission')),
            URLError('connection interrupted'),
            TimeoutError('request timed out'),
        ]
        for error in cases:
            with self.subTest(error=error), self.action_environment() as (result, summary):
                with patch.object(publish_edge, 'urlopen', side_effect=error) as send:
                    with self.assertRaises((RuntimeError, URLError, TimeoutError)):
                        publish_edge.main()
                send.assert_called_once()
                if isinstance(error, HTTPError):
                    self.assertTrue(error.fp.closed)
                self.assertFalse(result.exists())
                self.assertFalse(summary.exists())

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

    def test_action_polling_timeout_does_not_report_success_or_retry_submission(self):
        responses = [
            Response(202, location=UPLOAD_ID), Response(body={'status': 'Succeeded'}),
            Response(202, location=SUBMIT_ID), Response(body={'status': 'InProgress'}),
        ]
        with self.action_environment() as (result, summary), \
                patch.object(publish_edge.time, 'monotonic', side_effect=[0, 0, 0, 0, 601]), \
                patch.object(publish_edge.time, 'sleep'), \
                patch.object(publish_edge, 'urlopen', side_effect=responses) as send:
            with self.assertRaisesRegex(TimeoutError, 'Partner Center'):
                publish_edge.main()
            self.assertEqual(send.call_count, 4)
            self.assertFalse(result.exists())
            self.assertFalse(summary.exists())


if __name__ == '__main__':
    unittest.main()
