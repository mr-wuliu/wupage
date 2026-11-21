"""Submit an existing WuPage release to the Chrome Web Store API v2."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ITEM_ID = 'oimcejdmobjcmiklbidamgpfmgkdaiej'
STORE_API = 'https://chromewebstore.googleapis.com'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
CREDENTIALS = {
    'client_id': 'CHROME_CLIENT_ID',
    'client_secret': 'CHROME_CLIENT_SECRET',
    'refresh_token': 'CHROME_REFRESH_TOKEN',
}


def request_json(url, method, *, token=None, data=None, content_type=None):
    request = Request(url, data=data, method=method)
    if token:
        request.add_header('Authorization', f'Bearer {token}')
    if content_type:
        request.add_header('Content-Type', content_type)
    operation = url.rsplit(':', 1)[-1] if url.startswith(STORE_API) else 'token exchange'
    try:
        with urlopen(request, timeout=45) as response:
            result = json.load(response)
    except HTTPError as error:
        raise ValueError(f'Chrome {operation} returned HTTP {error.code}. '
                         'Check credentials and the Developer Dashboard before retrying.') from None
    except (URLError, TimeoutError):
        raise ValueError(f'Chrome {operation} could not be confirmed. '
                         'Check the Developer Dashboard before retrying.') from None
    if not isinstance(result, dict):
        raise ValueError(f'Unexpected Chrome {operation} response.')
    return result


class ChromeStore:
    def __init__(self, publisher, token):
        if not re.fullmatch(r'[A-Za-z0-9_-]+', publisher):
            raise ValueError('CHROME_PUBLISHER_ID has an invalid format.')
        self.item = f'publishers/{publisher}/items/{ITEM_ID}'
        self.token = token

    def status(self):
        result = request_json(f'{STORE_API}/v2/{self.item}:fetchStatus', 'GET', token=self.token)
        if result.get('itemId') != ITEM_ID:
            raise ValueError('Chrome returned an unexpected item ID.')
        return result

    def upload(self, archive):
        return request_json(f'{STORE_API}/upload/v2/{self.item}:upload', 'POST',
                            token=self.token, data=archive.read_bytes(), content_type='application/zip')

    def publish(self):
        return request_json(f'{STORE_API}/v2/{self.item}:publish', 'POST',
                            token=self.token, data=b'{}', content_type='application/json')


def version_parts(version):
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}', version):
        raise ValueError('The Chrome Web Store returned an invalid manifest version.')
    parts = tuple(map(int, version.split('.')))
    return parts + (0,) * (4 - len(parts))


def revision_versions(revision):
    return {version_parts(channel.get('crxVersion', ''))
            for channel in revision.get('distributionChannels', [])}


def existing_submission(status, version):
    if status.get('takenDown') or status.get('warned'):
        raise ValueError('Resolve the Chrome Web Store policy status in the Developer Dashboard.')
    published = status.get('publishedItemRevisionStatus', {})
    published_versions = revision_versions(published)
    if published.get('state') != 'PUBLISHED' or not published_versions:
        raise ValueError('Publish the first public version in the Chrome Web Store Developer Dashboard.')

    submitted = status.get('submittedItemRevisionStatus') or {}
    submitted_state = submitted.get('state')
    target = version_parts(version)
    if target in published_versions:
        return 'already_published'
    if target < max(published_versions):
        return 'superseded'
    if submitted_state in ('PENDING_REVIEW', 'STAGED'):
        if target in revision_versions(submitted):
            return 'already_submitted' if submitted_state == 'PENDING_REVIEW' else 'staged'
        return 'deferred'
    if submitted_state not in (None, 'CANCELLED'):
        raise ValueError('Resolve the existing Chrome submission in the Developer Dashboard.')
    if status.get('lastAsyncUploadState') == 'IN_PROGRESS':
        return 'deferred'
    return None


def submit(store, archive, version, *, dry_run=False):
    existing = existing_submission(store.status(), version)
    if dry_run:
        print(f'Chrome package and store access verified. Current status: {existing or "ready"}.')
        return 'dry_run'
    if existing:
        return existing

    uploaded = store.upload(archive)
    state = uploaded.get('uploadState')
    if state == 'IN_PROGRESS':
        for _ in range(60):
            time.sleep(5)
            state = store.status().get('lastAsyncUploadState')
            if state != 'IN_PROGRESS':
                break
    elif state == 'SUCCEEDED' and uploaded.get('crxVersion') != version:
        raise ValueError('The uploaded Chrome version does not match the release tag.')
    if state != 'SUCCEEDED':
        raise ValueError('Chrome upload did not report success. Check the Developer Dashboard before retrying.')

    result = store.publish()
    if result.get('state') == 'PUBLISHED':
        return 'published'
    if result.get('state') != 'PENDING_REVIEW':
        raise ValueError('Chrome did not confirm submission for review. Check the Developer Dashboard before retrying.')
    return 'submitted'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, help='Verified ZIP prepared for the Chrome Web Store')
    parser.add_argument('--version', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    publisher = os.environ.get('CHROME_PUBLISHER_ID', '').strip()
    oauth = {key: os.environ.get(name, '').strip() for key, name in CREDENTIALS.items()}

    if not args.archive.is_file():
        raise ValueError('The verified Chrome store ZIP is missing.')
    if args.dry_run and not any(oauth.values()):
        print('Chrome package verified. Store access was not checked because OAuth secrets are unset.')
        status = 'dry_run'
    else:
        missing = [name for key, name in CREDENTIALS.items() if not oauth[key]]
        if not publisher:
            missing.insert(0, 'CHROME_PUBLISHER_ID')
        if missing:
            raise ValueError('Configure these GitHub Actions settings: ' + ', '.join(missing))
        token = request_json(TOKEN_URL, 'POST', data=urlencode(dict(oauth, grant_type='refresh_token')).encode(),
                             content_type='application/x-www-form-urlencoded').get('access_token')
        if not isinstance(token, str) or not token:
            raise ValueError('Google OAuth did not return an access token.')
        status = submit(ChromeStore(publisher, token), args.archive, args.version, dry_run=args.dry_run)
    print(f'Chrome Web Store {args.version}: {status}.')
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a', encoding='utf-8') as stream:
            stream.write(f'submission_status={status}\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(f'ERROR: {error}')
