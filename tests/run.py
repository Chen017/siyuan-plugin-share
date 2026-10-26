"""Isolated PHP 8.3 regression suite; Python standard library only.

python tests/run.py --php /path/to/php
docker build --pull -f php-site/Dockerfile -t siyuan-share:php83-test .
python3 tests/run.py --docker siyuan-share:php83-test
"""
import argparse
from contextlib import closing
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pdf_export import PdfExportTests
from pdf_release import PdfReleaseTests
from pdf_cookie import PdfCookieTests

ROOT = Path(__file__).resolve().parents[1]
CONFIG = """<?php
return [
    'captcha_enabled' => false,
    'email_verification_enabled' => false,
    'smtp_enabled' => false,
    'central_stats_url' => '',
    'chunk_cleanup_probability' => 0,
];
"""
DIAGNOSTICS = re.compile(r'(?:PHP (?:Warning|Deprecated|Fatal error|Parse error|Notice)|(?:Warning|Deprecated|Fatal error|Parse error|Notice):)')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, path, data=None, headers=None, method=None, files=None):
        headers = dict(headers or {})
        if files is not None:
            boundary = uuid.uuid4().hex
            parts = []
            for key, value in (data or {}).items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            for key, (name, content) in files.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + content + b'\r\n')
            data = b''.join(parts) + f'--{boundary}--\r\n'.encode()
            headers['Content-Type'] = f'multipart/form-data; boundary={boundary}'
        elif isinstance(data, dict):
            data = urllib.parse.urlencode(data).encode()
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            if DIAGNOSTICS.search(body.decode('utf-8', errors='replace')):
                raise AssertionError('PHP diagnostic in response: ' + body[:500].decode(errors='replace'))
            return response.code, response.headers, body

    def form(self, path, fields):
        status, _, body = self.request(path)
        assert status == 200, (path, status)
        match = re.search(rb'name="csrf" value="([^"]+)"', body)
        assert match, 'CSRF token missing: ' + path
        return self.request(path, {'csrf': match[1].decode(), **fields})


class Regression(PdfCookieTests, PdfReleaseTests, PdfExportTests, unittest.TestCase):
    base = ''
    docker = False
    container = None
    database_path = None
    browser = False
    php_executable = None
    bootstrap_path = None

    def rows(self, sql):
        if self.container:
            output = subprocess.check_output(['docker', 'exec', self.container, 'php', '-r', '$p = new PDO("sqlite:/var/www/html/storage/app.db"); echo json_encode($p->query($argv[1])->fetchAll(PDO::FETCH_ASSOC));', sql], text=True)
            return json.loads(output)
        with closing(sqlite3.connect(self.database_path)) as connection, connection:
            connection.row_factory = sqlite3.Row
            return [dict(row) for row in connection.execute(sql)]

    def setUp(self):
        self.client = Client(self.base)
        self.name = 'test_' + uuid.uuid4().hex[:12]
        result = self.client.form('/register', {'username': self.name, 'email': self.name + '@example.com', 'password': 'Test-PHP83!pass'})
        self.assertEqual(result[0], 302)
        self.assertEqual(result[1]['Location'], '/dashboard')
        self.key = self.rotate_key(self.client)

    def rotate_key(self, client):
        status, _, body = client.request('/dashboard')
        self.assertEqual(status, 200)
        token = re.search(rb'name="csrf" value="([^"]+)"', body)
        self.assertIsNotNone(token)
        status, _, body = client.request('/api-key/rotate', {'csrf': token[1].decode()})
        self.assertEqual(status, 302)
        status, _, body = client.request('/dashboard')
        key = re.search(rb'\b[a-f0-9]{48}\b', body)
        self.assertIsNotNone(key, 'Generated API key missing')
        return key[0].decode()

    def csrf(self, client, page):
        status, _, body = client.request(page)
        self.assertEqual(status, 200)
        token = re.search(rb'name="csrf" value="([^"]+)"', body)
        self.assertIsNotNone(token)
        return token[1].decode()

    def admin(self):
        admin = Client(self.base)
        self.assertEqual(admin.form('/login', {'username': 'admin', 'password': '123456'})[0], 302)
        return admin

    def api(self, path, payload=None, key=None, status=200):
        headers = {'X-Api-Key': self.key if key is None else key}
        data = None
        if payload is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(payload, ensure_ascii=False).encode()
        actual, _, body = self.client.request('/api/v1/' + path, data, headers)
        self.assertEqual(actual, status, body[:500])
        result = json.loads(body)
        self.assertEqual(result['code'], 0 if status == 200 else status)
        return result['data']

    def share(self, **extra):
        payload = {'docId': self.name, 'title': '中文分享', 'markdown': 'PHP83_MARKER **中文正文**', **extra}
        return self.api('shares/doc', payload)['share']

    def test_notebook_reader_landing(self):
        share = self.api('shares/notebook', {
            'notebookId': self.name, 'title': '课程 <Notebook>',
            'docs': [
                {'docId': self.name + 'root', 'title': '课程 <A>', 'markdown': ''},
                {'docId': self.name + 'child', 'parentId': self.name + 'root', 'title': '内部讲义', 'markdown': '# 正文'},
                {'docId': self.name + 'other', 'title': '课程 B', 'markdown': '说明'},
            ],
        })['share']
        status, _, body = Client(self.base).request('/s/' + share['slug'])
        self.assertEqual(status, 200)
        text = body.decode()
        welcome = re.search(r'<section class="notebook-welcome".*?</section>', text).group()
        self.assertIn('课程 &lt;Notebook&gt;', welcome)
        self.assertNotIn('课程 &lt;A&gt;', welcome)
        self.assertNotIn('课程 B', welcome)
        self.assertNotIn('内部讲义', welcome)
        self.assertNotIn('<ul', welcome)
        self.assertIn('Browse documents', welcome)
        self.assertIn('Continue reading:', welcome)
        self.assertNotIn('展开文档树', welcome)
        self.assertIn('data-reader-resume hidden', welcome)
        self.assertIn('data-reader-show-tree', welcome)
        self.assertIn('reader-mobile-bar', text)
        self.assertNotIn('share-side-trigger', text)
        self.assertIn('/assets/style.css', text)
        status, _, body = Client(self.base).request('/s/' + share['slug'] + '?partial=1')
        self.assertEqual(status, 200)
        self.assertIn('data-notebook-welcome', json.loads(body)['data']['html'])
        for doc_id in [self.name + 'root', self.name + 'child', self.name + 'other']:
            status, _, body = Client(self.base).request('/s/' + share['slug'] + '/' + doc_id)
            self.assertEqual(status, 200)
            self.assertNotIn('data-reader-pages', body.decode())
            self.assertNotIn('reader-subpages', body.decode())

    def test_reader_home_setting_and_share_root_matching(self):
        notebook = self.api('shares/notebook', {
            'notebookId': self.name, 'title': 'Home notebook',
            'docs': [
                {'docId': self.name + '-parent', 'title': 'Parent', 'markdown': '# Parent content'},
                {'docId': self.name + '-child', 'parentId': self.name + '-parent', 'title': 'Child', 'markdown': '# Child content'},
            ],
        })['share']
        other = self.share(docId=self.name + '-other')
        home_path = '/s/' + notebook['slug']
        other_path = '/s/' + other['slug']
        admin = self.admin()
        original = self.rows('SELECT key, value FROM settings')
        fields = {'csrf': self.csrf(admin, '/admin'), 'allow_registration': '1'}
        visitor = Client(self.base)
        saved_home = self.base + home_path + '/?view=read#section'
        try:
            self.assertNotIn(b'data-reader-home', visitor.request(other_path)[2])
            self.assertIn(b'name="reader_home_url"', admin.request('/admin')[2])
            self.assertEqual(self.client.request('/admin/settings', {'csrf': self.csrf(self.client, '/account'), 'reader_home_url': saved_home})[0], 403)
            self.assertEqual(admin.request('/admin/settings', {**fields, 'reader_home_url': saved_home})[0], 302)
            self.assertEqual(self.rows("SELECT value FROM settings WHERE key='reader_home_url'")[0]['value'], saved_home)
            for suffix in ['', '?view=read', '/' + self.name + '-parent', '/' + self.name + '-child?partial=1']:
                status, _, page = visitor.request(home_path + suffix)
                self.assertEqual(status, 200)
                self.assertNotIn(b'data-reader-home', page)
            page = visitor.request(other_path)[2].decode()
            self.assertIn('data-reader-home href="' + saved_home + '"', page)
            self.assertIn('aria-label="Return to home">Home</a>', page)
            self.assertNotRegex(page, r'data-reader-home[^>]*data-share-nav')
            # An omitted field from an older form does not clear the saved home.
            self.assertEqual(admin.request('/admin/settings', fields)[0], 302)
            for invalid in ['javascript:alert(1)', '//example.com/s/home', 'https://user:pass@example.com/s/home', 'bad url']:
                self.assertEqual(admin.request('/admin/settings', {**fields, 'reader_home_url': invalid})[0], 302)
                self.assertEqual(self.rows("SELECT value FROM settings WHERE key='reader_home_url'")[0]['value'], saved_home)
            # Exact root identity: a longer slug must not be treated as the same home.
            for home in [self.base + home_path + '-different', 'https://other.example' + home_path]:
                admin.request('/admin/settings', {**fields, 'reader_home_url': home})
                self.assertIn(b'data-reader-home', visitor.request(home_path)[2])
                self.assertIn(b'data-reader-home', visitor.request(home_path + '/' + self.name + '-child?partial=1')[2])
            admin.request('/admin/settings', {**fields, 'reader_home_url': ''})
            self.assertNotIn(b'data-reader-home', visitor.request(other_path)[2])
        finally:
            for row in original:
                value = row['value'].replace("'", "''")
                key = row['key'].replace("'", "''")
                self.rows(f"UPDATE settings SET value='{value}' WHERE key='{key}'")

    def test_public_reader_controls_use_english(self):
        share = self.share(title='中文标题', markdown='# 正文\n\n原始中文内容不得翻译。')
        visitor = Client(self.base)
        for path in ['/', '/login', '/register', '/forgot', '/reset', '/s/' + share['slug'], '/s/' + share['slug'] + '/export']:
            status, _, body = visitor.request(path)
            if status != 200:
                continue
            html = body.decode()
            controls = re.findall(r'<button\b[^>]*>(.*?)</button>', html, re.S)
            for control in controls:
                label = re.sub(r'<[^>]+>', '', control)
                self.assertNotRegex(label, r'[\u3400-\u9fff]', (path, label))
        _, _, body = visitor.request('/s/' + share['slug'])
        self.assertIn('原始中文内容不得翻译。', body.decode())
        self.assertIn('reader-frame', body.decode())
        self.assertIn('>Source</button>', body.decode())
        self.assertIn('>Export PDF</a>', body.decode())
        protected = self.share(docId=self.name + '_protected', password='reader-pass')
        _, _, gate = visitor.request('/s/' + protected['slug'])
        self.assertIn('>Unlock</button>', gate.decode())

    def test_authentication_and_sessions(self):
        self.assertEqual(self.api('auth/verify')['user']['username'], self.name)
        self.api('auth/verify', key='wrong', status=401)
        status, _, body = self.client.request('/api/v1/auth/verify', headers={'Authorization': 'Bearer ' + self.key})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['code'], 0)
        stranger = Client(self.base)
        self.assertEqual(stranger.request('/dashboard')[0], 302)
        self.assertEqual(stranger.request('/admin')[0], 302)
        status, headers, _ = stranger.form('/login', {'username': self.name, 'password': 'wrong'})
        self.assertEqual((status, headers['Location']), (302, '/login'))
        status, headers, _ = stranger.form('/login', {'username': self.name, 'password': 'Test-PHP83!pass'})
        self.assertEqual((status, headers['Location']), (302, '/dashboard'))
        self.assertEqual(stranger.request('/dashboard')[0], 200)
        self.assertEqual(self.client.request('/login', {'username': self.name, 'password': 'Test-PHP83!pass', 'csrf': 'wrong'})[0], 400)
        self.assertEqual(self.client.request('/admin')[0], 403)

    def test_pages_and_captcha(self):
        for path in ['/', '/login', '/register', '/forgot', '/reset', '/account', '/dashboard']:
            self.assertIn(self.client.request(path)[0], [200, 302], path)
        self.assertEqual(self.client.request('/captcha')[0], 404)
        status, _, body = self.client.request('/s/nonexistent_share')
        self.assertNotIn(b'PHP83_MARKER', body)

    def test_reader_metadata_assets_and_not_found(self):
        share = self.share(title='Reader <test>', markdown='# Heading\n\nHello $x^2$')
        status, _, body = Client(self.base).request('/s/' + share['slug'])
        self.assertEqual(status, 200)
        self.assertIn(b"<meta name='description'", body)
        self.assertIn(b'role="main"', body)
        self.assertIn(b'Reader &lt;test&gt;', body)
        for library in ['mermaid.min.js', 'full.render.js', 'echarts.min.js', 'abcjs-basic-min.js']:
            self.assertNotIn(library.encode(), body, library)
        self.assertEqual(self.client.request('/unknown-audit-test-page')[0], 404)
        if self.docker:
            status, headers, font = self.client.request('/assets/MiSans-Latin.woff2')
            self.assertEqual(status, 200)
            self.assertTrue(font.startswith(b'wOF2'))
            self.assertLess(len(font), 100000)
            self.assertIn('max-age=', headers.get('Cache-Control', ''))
            status, headers, robots = self.client.request('/robots.txt')
            self.assertEqual(status, 200)
            self.assertIn('text/plain', headers.get('Content-Type', ''))
            self.assertIn(b'User-agent: *', robots)
            self.assertEqual(json.loads(self.client.request('/.well-known/ai-catalog.json')[2])['entries'], [])

    def test_share_create_update_snapshot_delete(self):
        share = self.share()
        path = '/s/' + share['slug']
        status, _, body = Client(self.base).request(path)
        self.assertEqual(status, 200)
        self.assertIn('中文正文'.encode(), body)
        listing = self.api('shares')
        self.assertIn(str(share['id']), json.dumps(listing))
        snapshot = self.api('shares/snapshot', {'shareId': share['id']})
        self.assertEqual(snapshot['docs'][0]['contentHash'], hashlib.sha256('PHP83_MARKER **中文正文**'.encode()).hexdigest())
        updated = self.share(markdown='UPDATED_MARKER **更新**')
        self.assertEqual(updated['id'], share['id'])
        self.assertIn(b'UPDATED_MARKER', Client(self.base).request(path)[2])
        self.api('shares/delete', {'shareId': share['id']})
        self.assertNotIn(b'UPDATED_MARKER', Client(self.base).request(path)[2])
        self.api('shares/delete', {'shareId': share['id'], 'hardDelete': True})
        self.api('shares/snapshot', {'shareId': share['id']}, status=404)

    def test_password_expiration_and_access_update(self):
        share = self.share(password='Share-Pass!')
        path = '/s/' + share['slug']
        visitor = Client(self.base)
        self.assertNotIn(b'PHP83_MARKER', visitor.request(path)[2])
        self.assertNotIn(b'PHP83_MARKER', visitor.request(path, {'share_password': 'wrong'})[2])
        self.assertEqual(visitor.request(path, {'share_password': 'Share-Pass!'})[0], 302)
        self.assertIn(b'PHP83_MARKER', visitor.request(path)[2])
        self.api('shares/access/update', {'shareId': share['id'], 'password': 'New-Pass!'})
        self.assertNotIn(b'PHP83_MARKER', visitor.request(path)[2])
        self.api('shares/access/update', {'shareId': share['id'], 'clearPassword': True, 'expiresAt': (int(time.time()) - 3600) * 1000})
        self.assertNotIn(b'PHP83_MARKER', Client(self.base).request(path)[2])
        self.api('shares/access/update', {'shareId': share['id'], 'clearExpires': True})
        self.assertIn(b'PHP83_MARKER', Client(self.base).request(path)[2])

    def test_visitor_limit(self):
        share = self.share(visitorLimit=1)
        path = '/s/' + share['slug']
        first = Client(self.base)
        self.assertIn(b'PHP83_MARKER', first.request(path)[2])
        self.assertIn(b'PHP83_MARKER', first.request(path)[2])
        self.assertNotIn(b'PHP83_MARKER', Client(self.base).request(path)[2])

    def test_notebook_tree_and_search(self):
        docs = [{'docId': self.name + str(i), 'title': '文档' + str(i), 'markdown': 'SEARCH_MARKER_' + str(i), 'parentId': self.name + '0' if i else ''} for i in range(2)]
        share = self.api('shares/notebook', {'notebookId': self.name, 'title': '笔记本', 'docs': docs})['share']
        for doc in docs:
            status, _, body = Client(self.base).request('/s/' + share['slug'] + '/' + doc['docId'])
            self.assertEqual(status, 200)
            self.assertIn(doc['markdown'].encode(), body)
        status, _, body = self.client.request('/s/' + share['slug'] + '/search?q=SEARCH_MARKER')
        self.assertEqual(status, 200)
        self.assertIn(b'SEARCH_MARKER', body)

    def test_multipart_asset_and_protected_download(self):
        marker = b'FILE_PHP83_MARKER'
        meta = {'docId': self.name, 'title': 'Asset', 'markdown': '[file](assets/test.txt)', 'password': 'File-Pass!'}
        fields = {'metadata': json.dumps(meta), 'assetPaths[]': 'assets/test.txt', 'assetDocIds[]': self.name}
        status, _, body = self.client.request('/api/v1/shares/doc', fields, {'X-Api-Key': self.key}, files={'assets[]': ('test.txt', marker)})
        self.assertEqual(status, 200, body)
        share = json.loads(body)['data']['share']
        path = '/s/' + share['slug']
        visitor = Client(self.base)
        self.assertNotIn(marker, visitor.request(path + '/res/assets/test.txt')[2])
        visitor.request(path, {'share_password': 'File-Pass!'})
        self.assertEqual(visitor.request(path + '/res/assets/test.txt')[2], marker)
        if self.docker:
            self.assertNotIn(marker, visitor.request('/uploads/' + str(share['id']) + '/assets/test.txt')[2])

    def test_chunk_upload_and_cancel(self):
        content = b'CHUNK_PHP83_MARKER'
        payload = {'metadata': {'docId': self.name, 'title': 'Chunks', 'markdown': 'Chunk document'}, 'assets': [{'path': 'assets/chunk.txt', 'size': len(content), 'hash': hashlib.sha256(content).hexdigest(), 'docId': self.name}]}
        initialized = self.api('shares/doc/init', payload)
        upload = initialized['uploadId']
        fields = {'uploadId': upload, 'assetPath': 'assets/chunk.txt', 'assetDocId': self.name, 'chunkIndex': 0, 'totalChunks': 1}
        status, _, body = self.client.request('/api/v1/shares/asset/chunk', fields, {'X-Api-Key': self.key}, files={'chunk': ('chunk.bin', content)})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)['code'], 0)
        completed = self.api('shares/upload/complete', {'uploadId': upload})
        share = {'id': completed['shareId'], 'slug': completed['slug']}
        self.assertEqual(Client(self.base).request('/s/' + share['slug'] + '/res/assets/chunk.txt')[2], content)
        pending = self.api('shares/doc/init', {'docId': self.name + 'cancel', 'markdown': 'cancel'})
        self.api('shares/upload/cancel', {'uploadId': pending['uploadId']})
        self.api('shares/upload/complete', {'uploadId': pending['uploadId']}, status=404)

    def test_incremental_document_update(self):
        docs = [{'docId': self.name + str(i), 'title': 'Document ' + str(i), 'markdown': 'ORIGINAL_MARKER_' + str(i)} for i in range(2)]
        share = self.share(docs=docs)
        patch = {'metadata': {'docId': self.name, 'title': 'Incremental', 'docs': [{**docs[0], 'markdown': 'INCREMENTAL_MARKER'}], 'incremental': {'enabled': True, 'deletedDocIds': [docs[1]['docId']]}}, 'assets': []}
        pending = self.api('shares/doc/init', patch)
        complete = self.api('shares/upload/complete', {'uploadId': pending['uploadId']})
        self.assertEqual(complete['shareId'], share['id'])
        snapshot = self.api('shares/snapshot', {'shareId': share['id']})
        self.assertEqual([d['docId'] for d in snapshot['docs']], [docs[0]['docId']])
        self.assertIn(b'INCREMENTAL_MARKER', Client(self.base).request('/s/' + share['slug'])[2])

    def test_owner_permissions_and_key_rotation(self):
        share = self.share()
        other = Client(self.base)
        self.assertEqual(other.form('/register', {'username': self.name + '_other', 'password': 'Other-Pass!'})[0], 302)
        key = self.rotate_key(other)
        self.api('shares/snapshot', {'shareId': share['id']}, key=key, status=404)
        self.api('shares/access/update', {'shareId': share['id'], 'password': 'hacked'}, key=key, status=404)
        self.api('shares/delete', {'shareId': share['id'], 'hardDelete': True}, key=key, status=404)
        new_key = self.rotate_key(self.client)
        self.api('auth/verify', key=self.key, status=401)
        self.api('auth/verify', key=new_key)

    def test_password_change_and_logout(self):
        status, headers, _ = self.client.form('/account', {'current_password': 'Test-PHP83!pass', 'new_password': 'Changed-Pass!', 'confirm_password': 'Changed-Pass!'})
        self.assertEqual((status, headers['Location']), (302, '/login'))
        self.assertEqual(self.client.request('/dashboard')[0], 302)
        self.client.form('/login', {'username': self.name, 'password': 'Test-PHP83!pass'})
        self.assertEqual(self.client.request('/dashboard')[0], 302)
        self.client.form('/login', {'username': self.name, 'password': 'Changed-Pass!'})
        token = self.csrf(self.client, '/dashboard')
        self.assertEqual(self.client.request('/logout', {'csrf': token})[0], 302)
        self.assertEqual(self.client.request('/dashboard')[0], 302)

    def test_comments_and_reports(self):
        share = self.share()
        path = '/s/' + share['slug']
        token = self.csrf(self.client, path)
        status, _, _ = self.client.request(path + '/comment', {'csrf': token, 'email': self.name + '@example.com', 'content': '**COMMENT_MARKER**'})
        self.assertEqual(status, 302)
        # This fork intentionally hides the public comments UI; verify the retained endpoints in SQLite.
        comments = self.rows(f"SELECT id, content FROM share_comments WHERE share_id = {int(share['id'])}")
        self.assertEqual(len(comments), 1)
        self.assertEqual(comments[0]['content'], '**COMMENT_MARKER**')
        comment_id = comments[0]['id']
        status, _, _ = self.client.request(path + '/comment/edit', {'csrf': token, 'comment_id': comment_id, 'email': self.name + '@example.com', 'content': 'EDITED_COMMENT_MARKER'})
        self.assertEqual(status, 302)
        self.assertEqual(self.rows(f'SELECT content FROM share_comments WHERE id = {int(comment_id)}')[0]['content'], 'EDITED_COMMENT_MARKER')
        status, _, _ = self.client.request(path + '/report', {'csrf': token, 'report_email': self.name + '@example.com', 'reason_type': 'other', 'reason_detail': 'REPORT_MARKER'})
        self.assertEqual(status, 302)
        admin = self.admin()
        self.assertIn(b'REPORT_MARKER', admin.request('/admin')[2])
        status, _, _ = self.client.request(path + '/comment/delete', {'csrf': token, 'comment_id': comment_id})
        self.assertEqual(status, 302)
        self.assertEqual(self.rows(f'SELECT id FROM share_comments WHERE id = {int(comment_id)}'), [])

    def test_admin_pages_settings_and_captcha(self):
        admin = self.admin()
        for page in ['/admin', '/admin-home', '/admin?tab=users', '/admin?tab=shares', '/admin?tab=reports']:
            status, _, body = admin.request(page)
            self.assertEqual(status, 200)
            self.assertNotIn(b'topbar-version is-update', body)
        token = self.csrf(admin, '/admin')
        settings = {'csrf': token, 'allow_registration': '1', 'default_storage_limit_mb': '1024', 'email_from': 'no-reply@example.com'}
        try:
            self.assertEqual(admin.request('/admin/settings', {**settings, 'captcha_enabled': '1'})[0], 302)
            status, headers, body = self.client.request('/captcha')
            self.assertEqual(status, 200)
            self.assertIn('image/', headers['Content-Type'])
            self.assertGreater(len(body), 50)
        finally:
            self.assertEqual(admin.request('/admin/settings', settings)[0], 302)

    def test_api_errors_and_cors(self):
        self.api('shares/doc', {}, status=400)
        self.api('shares/notebook', {}, status=400)
        self.api('shares/access/update', {}, status=400)
        self.api('shares/delete', {}, status=400)
        self.api('shares/upload/complete', {'uploadId': '0' * 32}, status=404)
        status, headers, _ = self.client.request('/api/v1/auth/verify', method='OPTIONS')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], '*')

    def test_nginx_protects_private_files(self):
        if not self.docker:
            self.skipTest('Nginx rules require the Docker image')
        for path in ['/config.php', '/storage/app.db', '/.git/config', '/vendor/Parsedown.php']:
            self.assertIn(self.client.request(path)[0], [403, 404], path)
        status, headers, body = self.client.request('/assets/app.js')
        self.assertEqual(status, 200)
        self.assertGreater(len(body), 1000)
        # Exercise real files in the disposable container: a static cache
        # location must not bypass the existing source/secret deny rules.
        probes = ['audit-probe.php', 'audit-probe.db', '.audit-probe']
        for name in probes:
            subprocess.run(['docker', 'exec', self.container, 'sh', '-ec',
                            'printf AUDIT_SECRET_MARKER > /var/www/html/assets/' + name], check=True)
        try:
            for name in probes:
                status, _, body = self.client.request('/assets/' + name)
                self.assertIn(status, [403, 404], name)
                self.assertNotIn(b'AUDIT_SECRET_MARKER', body)
        finally:
            subprocess.run(['docker', 'exec', self.container, 'rm', '-f',
                            *['/var/www/html/assets/' + name for name in probes]], check=True)


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--php', help='PHP 8.3 CLI executable')
    mode.add_argument('--docker', help='Already built application image')
    parser.add_argument('--browser', action='store_true', help='Also run Playwright UI/PDF tests (no application build)')
    args = parser.parse_args()
    process = container = None
    result = None
    log_text = ''
    with tempfile.TemporaryDirectory(prefix='siyuan-php83-') as directory:
        work = Path(directory)
        # Do not copy local configuration or persistent data, including on CI.
        app = work / 'app'
        shutil.copytree(ROOT / 'php-site', app, ignore=shutil.ignore_patterns('config.php', 'storage', 'uploads'))
        (app / 'config.php').write_text(CONFIG, encoding='utf-8')
        (app / 'storage').mkdir()
        (app / 'uploads').mkdir()
        source = (app / 'index.php').read_text(encoding='utf-8')
        marker = "\n$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';"
        if source.count(marker) != 1:
            raise RuntimeError('Cannot identify application routing boundary')
        (app / 'bootstrap.php').write_text(source.split(marker)[0], encoding='utf-8')
        php_log = work / 'php.log'
        php_ini = work / 'regression.ini'
        php_ini.write_text('error_reporting=E_ALL\nlog_errors=On\ndisplay_errors=Off\n', encoding='utf-8')
        try:
            if args.php:
                php = str(Path(args.php).resolve())
                php_args = [php, '-d', 'error_reporting=32767', '-d', 'log_errors=1', '-d', 'display_errors=0', '-d', 'error_log=' + str(php_log)]
                for path in app.rglob('*.php'):
                    command([*php_args, '-l', str(path)], stdout=subprocess.DEVNULL)
                command([*php_args, str(ROOT / 'tests/runtime.php'), str(app / 'bootstrap.php')])
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                router = work / 'router.php'
                router.write_text("<?php\n$requestPath = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);\n"
                                  "$file = realpath(__DIR__ . '/app' . $requestPath);\n"
                                  "$assets = realpath(__DIR__ . '/app/assets') . DIRECTORY_SEPARATOR;\n"
                                  "if ($file && str_starts_with($file, $assets) && is_file($file)) return false;\n"
                                  "$_SERVER['SCRIPT_NAME'] = '/index.php';\nrequire __DIR__ . '/app/index.php';\n", encoding='utf-8')
                output = (work / 'server.log').open('w', encoding='utf-8')
                process = subprocess.Popen([*php_args, '-S', f'127.0.0.1:{port}', '-t', str(app), str(router)], stdout=output, stderr=output)
            else:
                name = 'siyuan-php83-test-' + uuid.uuid4().hex[:10]
                container = name
                command(['docker', 'create', '--name', name, '--volume', '/var/www/html/storage', '--volume', '/var/www/html/uploads', '-p', '127.0.0.1::80', args.docker], stdout=subprocess.DEVNULL)
                for source_path, destination in [(app / 'config.php', '/var/www/html/config.php'), (app / 'bootstrap.php', '/var/www/html/bootstrap.php'), (php_ini, '/usr/local/etc/php/conf.d/zz-regression.ini'), (ROOT / 'tests/runtime.php', '/tmp/runtime.php'), (ROOT / 'tests/pdf-race.php', '/tmp/pdf-race.php')]:
                    command(['docker', 'cp', str(source_path), name + ':' + destination])
                command(['docker', 'start', name], stdout=subprocess.DEVNULL)
                port = subprocess.check_output(['docker', 'port', name, '80/tcp'], text=True).strip().rsplit(':', 1)[1]
                command(['docker', 'exec', name, 'sh', '-ec', 'find /var/www/html -name "*.php" -exec php -l {} \\; > /tmp/lint.log 2>&1; cat /tmp/lint.log; ! grep -E "Errors parsing|Parse error|Deprecated:|Warning:" /tmp/lint.log'])
                command(['docker', 'exec', name, 'nginx', '-t'])
                command(['docker', 'exec', name, 'php-fpm', '-t'])
                command(['docker', 'exec', '--user', 'www-data', name, 'php', '/tmp/runtime.php', '/var/www/html/bootstrap.php'])
            Regression.base = f'http://127.0.0.1:{port}'
            Regression.docker = bool(args.docker)
            Regression.container = container
            Regression.database_path = str(app / 'storage/app.db')
            Regression.browser = args.browser
            Regression.php_executable = args.php
            Regression.bootstrap_path = str(app / 'bootstrap.php')
            deadline = time.monotonic() + 45
            while True:
                try:
                    status = Client(Regression.base).request('/login')[0]
                    if status == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError('Application did not become ready')
                time.sleep(0.25)
            suite = unittest.defaultTestLoader.loadTestsFromTestCase(Regression)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            if container:
                # Wait for the real image HEALTHCHECK, then verify persistence on restart.
                for _ in range(45):
                    health = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Health.Status}}', container], text=True).strip()
                    if health != 'starting':
                        break
                    time.sleep(1)
                if health != 'healthy':
                    raise RuntimeError('Container healthcheck: ' + health)
                command(['docker', 'exec', container, 'php', '-r', '$p = new PDO("sqlite:/var/www/html/storage/app.db"); if ($p->query("PRAGMA integrity_check")->fetchColumn() !== "ok") exit(1);'])
                counts = ['docker', 'exec', container, 'php', '-r', '$p = new PDO("sqlite:/var/www/html/storage/app.db"); echo $p->query("SELECT COUNT(*) FROM users")->fetchColumn(), ":", $p->query("SELECT COUNT(*) FROM shares")->fetchColumn();']
                before = subprocess.check_output(counts)
                command(['docker', 'stop', '--time', '15', container], stdout=subprocess.DEVNULL)
                exit_code = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.ExitCode}}', container], text=True).strip()
                if exit_code != '0':
                    raise RuntimeError('Ungraceful container shutdown: ' + exit_code)
                command(['docker', 'start', container], stdout=subprocess.DEVNULL)
                command(['docker', 'exec', container, 'curl', '--retry', '15', '--retry-connrefused', '--retry-delay', '1', '--fail', '--silent', '--output', '/dev/null', 'http://127.0.0.1/login'])
                if subprocess.check_output(counts) != before:
                    raise RuntimeError('Database records changed across restart')
                # Also accept the signal inherited by older PHP-FPM base images.
                command(['docker', 'stop', '--signal', 'SIGQUIT', '--time', '15', container], stdout=subprocess.DEVNULL)
                exit_code = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.ExitCode}}', container], text=True).strip()
                if exit_code != '0':
                    raise RuntimeError('Ungraceful SIGQUIT shutdown: ' + exit_code)
                print('Docker health, graceful shutdown and database persistence passed')
        finally:
            if process:
                process.terminate()
                process.wait(timeout=15)
                output.close()
                log_text = (work / 'server.log').read_text(encoding='utf-8', errors='replace')
            if container:
                logs = subprocess.run(['docker', 'logs', container], capture_output=True, text=True)
                log_text = logs.stdout + logs.stderr
                subprocess.run(['docker', 'rm', '-f', '-v', container], check=True, stdout=subprocess.DEVNULL)
            if php_log.exists():
                log_text += php_log.read_text(encoding='utf-8', errors='replace')
            diagnostics = [line for line in log_text.splitlines() if DIAGNOSTICS.search(line)]
            if diagnostics:
                print('\nPHP diagnostics:\n' + '\n'.join(diagnostics))
    return 0 if result and result.wasSuccessful() and not diagnostics else 1


if __name__ == '__main__':
    raise SystemExit(main())
