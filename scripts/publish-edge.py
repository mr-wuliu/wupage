"""Submit an existing release ZIP with the Edge Add-ons v1.1 API (stdlib only).

https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
"""

import io
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import UUID
from zipfile import ZipFile


API_ROOT = 'https://api.addons.microsoftedge.microsoft.com/v1'


def validate_package(package, tag):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise ValueError('Only stable v<major>.<minor>.<patch> releases can be submitted.')
    with ZipFile(io.BytesIO(package)) as archive:
        manifests = [name for name in archive.namelist()
                     if name.replace('\\', '/').rsplit('/', 1)[-1].lower() == 'manifest.json']
        if manifests != ['manifest.json']:
            raise ValueError('The ZIP must contain exactly one manifest.json, at its root. '
                             f'Found: {manifests}')
        manifest = json.loads(archive.read('manifest.json'))
    version = tag[1:]
    if manifest.get('version') != version or manifest.get('version_name', version) != version:
        raise ValueError(f'The ZIP manifest version must match release {tag}.')
    if 'key' in manifest or 'update_url' in manifest:
        raise ValueError('The Edge store manifest must not contain key or update_url; '
                         'prepare the release ZIP with scripts/package-edge.py.')


class EdgeClient:
    def __init__(self, product_id, client_id, api_key):
        self.base_url = f'{API_ROOT}/products/{UUID(product_id)}'
        self.headers = {'Authorization': f'ApiKey {api_key}', 'X-ClientID': client_id}

    def request(self, method, path, body=None, content_type=None):
        headers = dict(self.headers)
        if content_type:
            headers['Content-Type'] = content_type
        request = Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=120) as response:
                return response.status, response.headers, response.read()
        except HTTPError as error:
            detail = error.read().decode('utf-8', errors='replace')
            if error.code in (401, 403):
                detail = 'Check EDGE_CLIENT_ID and EDGE_API_KEY, including the API key expiry date. ' + detail
            raise RuntimeError(f'Edge API {method} {path}: HTTP {error.code}. {detail}') from None

    def start_operation(self, path, body, content_type):
        status, headers, _ = self.request('POST', path, body, content_type)
        if status != 202:
            raise RuntimeError(f'Edge API did not accept {path}: HTTP {status}.')
        location = headers.get('Location', '').strip()
        # The service may return an operation ID or a full operation URL.
        # Reconstruct our own polling URL so credentials stay on the API host.
        try:
            operation_id = str(UUID(urlsplit(location).path.rstrip('/').rsplit('/', 1)[-1]))
        except ValueError:
            raise RuntimeError(f'Edge API returned an invalid operation Location for {path}.') from None
        print(f'Accepted {path}; operation {operation_id}.')
        return f'{path}/operations/{operation_id}'

    def wait_for_operation(self, path, timeout=600, interval=10):
        deadline = time.monotonic() + timeout
        previous_status = None
        while time.monotonic() < deadline:
            code, _, body = self.request('GET', path)
            if code not in (200, 202):
                raise RuntimeError(f'Could not check Edge operation: HTTP {code}.')
            result = json.loads(body) if body.strip() else {}
            # The live API also uses 202 while an operation is processing,
            # including responses without a JSON body.
            status = result.get('status', 'InProgress' if code == 202 else None)
            if status != previous_status:
                print(f'Operation status: {status}')
                previous_status = status
            if status == 'Succeeded':
                return
            if status != 'InProgress':
                raise RuntimeError('Edge operation failed: ' + json.dumps(result, ensure_ascii=False))
            time.sleep(interval)
        raise TimeoutError(
            f'Timed out waiting for Edge operation {path}. '
            'Check its status in Partner Center before retrying.'
        )


def publish_package(client, package_path, tag):
    package = Path(package_path).read_bytes()
    validate_package(package, tag)
    print(f'Uploading the GitHub Release package for {tag}.')
    upload = client.start_operation(
        '/submissions/draft/package', package, 'application/zip'
    )
    client.wait_for_operation(upload)
    print('Package upload succeeded. Submitting for Microsoft certification.')
    submission = client.start_operation(
        '/submissions',
        json.dumps({'notes': f'WuPage {tag}. Package matches the corresponding GitHub Release.'}).encode(),
        'application/json',
    )
    client.wait_for_operation(submission)
    print(f'{tag} submitted successfully. Store availability depends on Microsoft certification.')


def main():
    required = ('EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY', 'RELEASE_TAG')
    config = {name: os.environ.get(name, '').strip() for name in required}
    missing = [name for name, value in config.items() if not value]
    if missing:
        raise ValueError('Missing required environment variables: ' + ', '.join(missing))
    if len(sys.argv) != 2:
        raise ValueError('Usage: python3 scripts/publish-edge.py <release.zip>')
    client = EdgeClient(config['EDGE_PRODUCT_ID'], config['EDGE_CLIENT_ID'], config['EDGE_API_KEY'])
    publish_package(client, sys.argv[1], config['RELEASE_TAG'])
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as output:
            output.write(
                f"Microsoft Edge Add-ons: **{config['RELEASE_TAG']} submitted for certification**.\n\n"
                'The upload and submission operations succeeded. '
                'Microsoft certification and store rollout are still pending.\n'
            )


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
