"""Guest export permissions, resource budgets and shared abuse limits."""
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
import time
import unittest


class PdfExportTests:
    def test_pdf_dialog_cancellation_is_scoped_and_handles_pending_submission(self):
        visitor, path, csrf = self.pdf_visitor(self.share())
        def ticket():
            page = visitor.request(path)[2]
            return re.search(rb'name="ticket" value="([a-f0-9]+)"', page)[1].decode()
        cancelled = ticket()
        self.assertEqual(visitor.request(path + '/release', {'csrf': csrf, 'ticket': cancelled})[0], 204)
        self.assertEqual(self.pdf_post(visitor, path, csrf, auto_download='1', ticket=cancelled)[0], 409)
        active = ticket()
        result = self.pdf_post(visitor, path, csrf, auto_download='1', ticket=active)
        self.assertEqual(result[0], 200, result[2])
        lease = self.pdf_lease(result[2])
        unrelated = ticket()
        visitor.request(path + '/release', {'csrf': csrf, 'ticket': unrelated})
        self.assertEqual(visitor.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 200)
        visitor.request(path + '/release', {'csrf': csrf, 'ticket': active})
        self.assertEqual(visitor.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 410)

    def test_pdf_quota_status_rolls_forward_and_obeys_permissions(self):
        visitor, path, csrf = self.pdf_visitor(self.share())
        identity = self.pdf_visitor_hash(visitor)
        with self.pdf_limit(120):
            response = visitor.request(path + '/quota', {'csrf': csrf})
            self.assertEqual(response[0], 200)
            self.assertEqual(json.loads(response[2])['quota']['remaining'], 120)
            now = int(time.time())
            self.rows(f"INSERT INTO pdf_export_events(ip_hash, fingerprint_hash, visitor_hash, created_at, doc_count) VALUES ('ip', 'fp', '{identity}', {now - 30}, 119), ('ip', 'fp', '{identity}', {now - 10}, 1)")
            quota = json.loads(visitor.request(path + '/quota', {'csrf': csrf})[2])['quota']
            self.assertEqual((quota['used'], quota['remaining']), (120, 0))
            self.assertEqual(quota['next_recovery_at'], now - 30 + 3600)
            self.assertEqual(quota['next_recovery_count'], 119)
            with self.pdf_limit(1):
                reduced = json.loads(visitor.request(path + '/quota', {'csrf': csrf})[2])['quota']
                self.assertEqual(reduced['next_recovery_at'], now - 10 + 3600)
                self.assertEqual(reduced['next_recovery_count'], 1)
            self.assertEqual(visitor.request(path + '/quota', {'csrf': 'wrong'})[0], 400)
            self.rows(f'UPDATE pdf_export_events SET created_at = {now - 3601}')
            quota = json.loads(visitor.request(path + '/quota', {'csrf': csrf})[2])['quota']
            self.assertEqual(quota['remaining'], 120)
            self.assertIsNone(quota['next_recovery_at'])

    def pdf_admin_form(self, admin):
        status, _, page = admin.request('/admin#settings')
        self.assertEqual(status, 200)
        form = re.search(r'<form[^>]+data-pdf-settings-form>(.*?)</form>', page.decode(), re.S)
        self.assertIsNotNone(form)
        values = dict(re.findall(r'name="([^"]+)"[^>]*value="([^"]*)"', form[1]))
        values = {key: html.unescape(value) for key, value in values.items()}
        enabled = re.search(r'name="pdf_export_enabled"[^>]*checked', form[1])
        if not enabled:
            values.pop('pdf_export_enabled', None)
        values['pdf_export_trusted_proxies'] = html.unescape(re.search(r'name="pdf_export_trusted_proxies"[^>]*>(.*?)</textarea>', form[1], re.S)[1])
        values['pdf_export_ip_header'] = re.search(r'<option value="([^"]+)" selected>', form[1])[1]
        return values

    def test_pdf_admin_settings_enable_and_immediate_limits(self):
        share, docs = self.pdf_notebook(2)
        visitor, path, token = self.pdf_visitor(share)
        admin = self.admin()
        original = self.pdf_admin_form(admin)
        general_before = self.rows("SELECT key, value FROM settings WHERE key NOT LIKE 'pdf_export_%' ORDER BY key")
        active = self.pdf_post(visitor, path, token)[2]
        lease = self.pdf_lease(active)
        try:
            disabled = {key: value for key, value in original.items() if key != 'pdf_export_enabled'}
            self.assertEqual(admin.request('/admin/pdf-export-settings', disabled)[0], 302)
            self.assertNotIn(b'data-pdf-export-link', visitor.request(path[:-7] + '/' + docs[0]['docId'])[2])
            self.assertEqual(visitor.request(path)[0], 404)
            self.assertEqual(self.pdf_post(visitor, path, token)[0], 404)
            self.assertEqual(visitor.request(path + '/verify', {'csrf': token, 'lease': lease})[0], 404)
            visitor.request(path + '/release', {'csrf': token, 'lease': lease})
            self.rows('DELETE FROM pdf_export_events')
            changed = {**original, 'limits[max_docs]': '1', 'limits[requests]': '1', 'limits[window_seconds]': '60',
                       'limits[max_concurrent]': '1', 'limits[max_markdown_bytes]': '0.5',
                       'limits[max_execution_seconds]': '10', 'limits[max_memory_bytes]': '64',
                       'pdf_export_trusted_proxies': '192.0.2.1,2001:0db8:0:0:0:0:0:1', 'pdf_export_ip_header': 'HTTP_CF_CONNECTING_IP'}
            self.assertEqual(admin.request('/admin/pdf-export-settings', changed)[0], 302)
            restored_form = self.pdf_admin_form(admin)
            self.assertEqual(restored_form['limits[max_docs]'], '1')
            self.assertEqual(restored_form['limits[max_markdown_bytes]'], '0.5')
            self.assertEqual(restored_form['pdf_export_trusted_proxies'], '192.0.2.1\n2001:db8::1')
            self.assertEqual(restored_form['pdf_export_ip_header'], 'HTTP_CF_CONNECTING_IP')
            self.assertEqual(self.rows("SELECT value FROM settings WHERE key = 'pdf_export_max_markdown_bytes'")[0]['value'], '524288')
            self.assertEqual(self.pdf_post(visitor, path, token)[0], 413)
            result = self.pdf_post(visitor, path, token, scope='single', doc_id=docs[0]['docId'])
            self.assertEqual(result[0], 200)
            one_lease = self.pdf_lease(result[2])
            self.assertEqual(visitor.request(path + '/claim', {'csrf': token, 'lease': one_lease, 'index': '0'})[0], 200)
            visitor.request(path + '/release', {'csrf': token, 'lease': one_lease})
            self.assertEqual(self.pdf_post(visitor, path, token, scope='single', doc_id=docs[0]['docId'])[0], 429)
            self.assertEqual(self.rows("SELECT key, value FROM settings WHERE key NOT LIKE 'pdf_export_%' ORDER BY key"), general_before)
        finally:
            admin.request('/admin/pdf-export-settings', original)
            self.rows('DELETE FROM pdf_export_leases')
            self.rows('DELETE FROM pdf_export_events')

    def test_pdf_admin_settings_authorization_and_validation(self):
        visitor = type(self.client)(self.base)
        self.assertEqual(visitor.request('/admin/pdf-export-settings', {})[0], 302)
        self.assertEqual(self.client.request('/admin/pdf-export-settings', {})[0], 400)
        admin = self.admin()
        original = self.pdf_admin_form(admin)
        before = self.rows("SELECT key, value FROM settings WHERE key LIKE 'pdf_export_%' ORDER BY key")
        self.assertEqual(admin.request('/admin/pdf-export-settings', {**original, 'csrf': 'wrong'})[0], 400)
        self.assertEqual(admin.request('/admin/pdf-export-settings', {**original, 'csrf[x]': 'wrong'})[0], 400)
        for invalid in [
            {'limits[max_docs]': '121'}, {'limits[requests]': '0'}, {'limits[window_seconds]': '1e2'},
            {'limits[requests]': '257'}, {'limits[window_seconds]': '0'}, {'limits[window_seconds]': '1441'},
            {'limits[max_docs]': '2.5'}, {'limits[max_markdown_bytes]': '-1'},
            {'limits[max_memory_bytes]': '1'}, {'limits[max_concurrent][x]': '1'},
            {'pdf_export_enabled[x]': '1'}, {'pdf_export_trusted_proxies': '0.0.0.0/0'},
            {'pdf_export_trusted_proxies': '*'}, {'pdf_export_trusted_proxies': 'localhost'},
            {'pdf_export_trusted_proxies[]': '127.0.0.1'}, {'pdf_export_ip_header': 'HTTP_X_FORWARDED_FOR'},
            {'pdf_export_ip_header[x]': 'HTTP_X_REAL_IP'},
        ]:
            payload = {**original, 'limits[max_docs]': '1', **invalid}
            self.assertEqual(admin.request('/admin/pdf-export-settings', payload)[0], 302)
            self.assertEqual(self.rows("SELECT key, value FROM settings WHERE key LIKE 'pdf_export_%' ORDER BY key"), before, invalid)
        self.assertEqual(admin.request('/admin/pdf-export-settings', {'csrf': original['csrf']})[0], 302)
        self.assertEqual(self.rows("SELECT key, value FROM settings WHERE key LIKE 'pdf_export_%' ORDER BY key"), before)

    def test_pdf_atomic_global_admission(self):
        share = self.share()
        self.pdf_visitor(share)
        results = self.pdf_workers(share, 8)
        self.assertEqual(results.count('accepted'), 4, results)
        self.assertEqual(results.count('limited'), 4, results)
        self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 4)

    def test_pdf_browser_rendering_and_save(self):
        if not self.browser:
            self.skipTest('Use --browser for Playwright UI/PDF checks')
        import struct
        import zlib
        marker = '公式、图片、表格与代码的导出检查。'
        markdown = marker + '\n\n## 重复标题\n\n行内公式 $E=mc^2$。\n\n$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$\n\n| 项目 | 数值 |\n|:---|---:|\n| Alpha | 42 |\n| Beta | 108 |\n\n```python\nprint("PDF_CODE_MARKER")\n```\n\n![本地图片](assets/pdf-test.png)\n\n```mermaid\ngraph LR\n A[Guest] --> B[PDF]\n```\n\n脚注[^1]\n\n[^1]: 第一篇脚注。'
        docs = [{'docId': self.name + str(i), 'title': ['公式与排版', '第二篇文档'][i],
                 'markdown': markdown if i == 0 else 'PDF_SECOND_DOCUMENT\n\n## 重复标题\n\n脚注[^1]\n\n[^1]: 第二篇脚注。'} for i in range(2)]
        meta = {'notebookId': self.name, 'title': 'PDF 浏览器回归', 'docs': docs}
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        pixels = b''.join(b'\0' + bytes([30, 100 + y, 210]) * 240 for y in range(80))
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 240, 80, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
        status, _, body = self.client.request('/api/v1/shares/notebook',
            {'metadata': json.dumps(meta), 'assetPaths[]': 'assets/pdf-test.png', 'assetDocIds[]': docs[0]['docId']},
            {'X-Api-Key': self.key}, files={'assets[]': ('pdf-test.png', png)})
        self.assertEqual(status, 200, body)
        share = json.loads(body)['data']['share']
        self.pdf_visitor(share)
        output = Path(__file__).resolve().parents[1] / '.test-output'
        output.mkdir(exist_ok=True)
        subprocess.run(['node', str(Path(__file__).with_name('pdf-browser.cjs')), self.base + '/s/' + share['slug'], str(output)],
                       input=json.dumps({'apiKey': self.key, 'shareId': share['id'], 'docIds': [doc['docId'] for doc in docs], 'visitorCookie': self.pdf_worker_cookie}), text=True, check=True, timeout=240)

    def pdf_visitor(self, share, password=None):
        self.rows('DELETE FROM pdf_export_events')
        self.rows('DELETE FROM pdf_export_leases')
        self.rows('DELETE FROM pdf_export_fingerprints')
        self.rows('DELETE FROM pdf_export_clearance')
        self.rows('DELETE FROM pdf_export_challenges')
        self.rows('DELETE FROM pdf_export_captcha_limits')
        client = type(self.client)(self.base)
        path = '/s/' + share['slug']
        if password:
            self.assertEqual(client.request(path, {'share_password': password})[0], 302)
        token = self.csrf(client, path + '/export')
        self.pdf_worker_cookie = next(cookie.value for cookie in client.cookies if cookie.name == 'sps_pdf_visitor')
        return client, path + '/export', token

    def pdf_post(self, client, path, token, headers=None, **overrides):
        data = {'csrf': token, 'fingerprint': 'a' * 64, 'scope': 'all', **overrides}
        return client.request(path, data, headers)

    def pdf_lease(self, body):
        token = re.search(rb'data-lease="([a-f0-9]+)"', body)
        self.assertIsNotNone(token, body[:200])
        return token[1].decode()

    def pdf_manifest(self, body):
        manifest = re.search(rb'<script type="application/json" data-pdf-manifest>(.*?)</script>', body, re.S)
        self.assertIsNotNone(manifest, body[:200])
        return json.loads(manifest[1])

    def pdf_document(self, client, path, csrf, lease, index=0):
        result = client.request(path + '/document', {'csrf': csrf, 'lease': lease, 'index': str(index)})
        if result[0] == 200:
            self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease, 'finish': str(index)})[0], 200)
        return result

    def pdf_notebook(self, count=4):
        docs = []
        for index in range(count):
            docs.append({'docId': self.name + str(index), 'title': '文档' + str(index),
                         'markdown': 'PDF_MARKER_' + str(index),
                         'parentId': self.name + '0' if index in [1, 2] else ''})
        share = self.api('shares/notebook', {'notebookId': self.name, 'title': 'PDF 笔记本', 'docs': docs})['share']
        return share, docs

    def test_pdf_guest_single_and_rendering_source(self):
        markdown = 'PDF_GUEST_MARKER\n\n$$x^2 + y^2 = z^2$$\n\n| A | B |\n|---|---|\n|1|2|\n\n```python\nprint(1)\n```\n\n![图片](assets/example.png)\n\n<script>alert(1)</script>'
        share = self.share(markdown=markdown)
        client, path, csrf = self.pdf_visitor(share)
        self.assertIn(b'data-pdf-export-link', client.request(path[:-7])[2])
        status, headers, body = self.pdf_post(client, path, csrf, scope='single', doc_id=self.name)
        self.assertEqual(status, 200, body)
        self.assertIn('no-store', headers['Cache-Control'])
        self.assertNotIn(b'PDF_GUEST_MARKER', body)  # admission returns a manifest, not all rendered content
        lease = self.pdf_lease(body)
        status, _, rendered = self.pdf_document(client, path, csrf, lease)
        self.assertEqual(status, 200, rendered)
        for fragment in [b'PDF_GUEST_MARKER', b'x^2', b'<table>', b'<code', b'/res/assets/example.png', b'data-pdf-preview']:
            self.assertIn(fragment, rendered)
        self.assertNotIn(b'<script>alert(1)</script>', rendered)
        self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 200)
        self.assertEqual(client.request('/dashboard')[0], 302)  # still an unauthenticated Guest
        self.assertEqual(client.request(path + '/release', {'csrf': csrf, 'lease': lease})[0], 204)
        self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 410)

    def test_pdf_batch_scopes_and_cross_share_rejection(self):
        share, docs = self.pdf_notebook()
        client, path, csrf = self.pdf_visitor(share)
        for scope, extra, expected in [
            ('single', {'doc_id': docs[1]['docId']}, [1]),
            ('tree', {'doc_id': docs[0]['docId']}, [0, 1, 2]),
            ('all', {}, [0, 1, 2, 3]),
            ('selected', {'doc_ids[0]': docs[1]['docId'], 'doc_ids[1]': docs[3]['docId']}, [1, 3]),
        ]:
            status, _, body = self.pdf_post(client, path, csrf, scope=scope, **extra)
            self.assertEqual(status, 200, body)
            self.assertEqual(len(self.pdf_manifest(body)), len(expected))
            lease = self.pdf_lease(body)
            rendered = b''.join(self.pdf_document(client, path, csrf, lease, index)[2] for index in range(len(expected)))
            for i in range(4):
                self.assertEqual(('PDF_MARKER_' + str(i)).encode() in rendered, i in expected, (scope, i))
            client.request(path + '/release', {'csrf': csrf, 'lease': self.pdf_lease(body)})
        other = self.share(markdown='PRIVATE_OTHER_SHARE')
        self.assertNotEqual(other['id'], share['id'])
        self.rows('DELETE FROM pdf_export_events')
        for extra in [{'scope': 'single', 'doc_id': self.name}, {'scope': 'selected', 'doc_ids[0]': self.name}, {'scope': 'tree', 'doc_id': self.name}]:
            status, _, body = self.pdf_post(client, path, csrf, fingerprint='c' * 64, **extra)
            self.assertEqual(status, 404, body)
            self.assertNotIn(b'PRIVATE_OTHER_SHARE', body)
        self.rows(f"UPDATE share_docs SET parent_id = '{docs[1]['docId']}' WHERE share_id = {int(share['id'])} AND doc_id = '{docs[0]['docId']}'")
        status, _, body = self.pdf_post(client, path, csrf, fingerprint='d' * 64, scope='tree', doc_id=docs[0]['docId'])
        self.assertEqual(status, 200, body)
        self.assertEqual(len(self.pdf_manifest(body)), 3)  # cycle terminates without duplicates

    def test_pdf_password_revocation_expiry_and_deletion(self):
        from run import Client
        share = self.share(password='PDF-Pass!')
        path = '/s/' + share['slug'] + '/export'
        self.assertEqual(Client(self.base).request(path)[0], 403)
        client, path, csrf = self.pdf_visitor(share, 'PDF-Pass!')
        status, _, body = self.pdf_post(client, path, csrf)
        self.assertEqual(status, 200)
        lease = self.pdf_lease(body)
        self.api('shares/access/update', {'shareId': share['id'], 'password': 'Changed-Pass!'})
        self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 403)
        self.assertEqual(self.pdf_post(client, path, csrf)[0], 403)
        self.api('shares/access/update', {'shareId': share['id'], 'clearPassword': True, 'expiresAt': (int(time.time()) - 60) * 1000})
        self.assertEqual(client.request(path)[0], 410)
        self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 410)
        self.api('shares/delete', {'shareId': share['id']})
        self.assertEqual(client.request(path)[0], 404)

    def test_pdf_legacy_share_limit_csrf_and_input_validation(self):
        from run import Client
        share = self.share(visitorLimit=1)
        client, path, csrf = self.pdf_visitor(share)
        client.request(path[:-7])  # Legacy share limits no longer restrict export access.
        self.assertEqual(Client(self.base).request(path)[0], 200)
        self.assertEqual(self.pdf_post(client, path, 'wrong')[0], 400)
        error_status, _, error_body = client.request(path, {'csrf': 'wrong'}, {'Accept': 'text/html'})
        self.assertEqual(error_status, 400)
        self.assertIn(b'Back to share', error_body)
        self.assertEqual(self.pdf_post(client, path, csrf, fingerprint='invalid')[0], 400)
        self.assertEqual(client.request(path, method='PUT')[0], 405)
        self.assertEqual(self.pdf_post(client, path, csrf, scope='unknown')[0], 400)
        self.assertEqual(self.pdf_post(client, path, csrf, **{'scope[0]': 'all'})[0], 400)
        self.assertEqual(self.pdf_post(client, path, csrf, scope='selected', **{'doc_ids[0][0]': self.name})[0], 400)
        self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)

    def test_pdf_concurrency_lease_ownership_and_timeout(self):
        from run import Client
        share = self.share()
        client, path, csrf = self.pdf_visitor(share)
        status, _, body = self.pdf_post(client, path, csrf)
        self.assertEqual(status, 200)
        lease = self.pdf_lease(body)
        self.assertEqual(self.pdf_post(client, path, csrf, fingerprint='b' * 64)[0], 429)
        other = Client(self.base)
        other_csrf = self.csrf(other, path)
        self.assertEqual(other.request(path + '/verify', {'csrf': other_csrf, 'lease': lease})[0], 410)
        other.request(path + '/release', {'csrf': other_csrf, 'lease': lease})
        self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 200)
        self.rows('UPDATE pdf_export_leases SET expires_at = 1')
        self.assertEqual(client.request(path + '/verify', {'csrf': csrf, 'lease': lease})[0], 410)
        self.assertEqual(self.pdf_post(client, path, csrf)[0], 200)

    def test_pdf_incremental_batch_slots_and_shared_lease(self):
        share, docs = self.pdf_notebook(4)
        client, path, csrf = self.pdf_visitor(share)
        body = self.pdf_post(client, path, csrf)[2]
        lease = self.pdf_lease(body)
        fields = {'csrf': csrf, 'lease': lease}
        self.assertEqual(client.request(path + '/document', {**fields, 'index': '4'})[0], 400)
        for index in range(3):
            response = client.request(path + '/document', {**fields, 'index': str(index)})
            self.assertEqual(response[0], 200, response[2][:200])
            self.assertIn(('PDF_MARKER_' + str(index)).encode(), response[2])
        self.assertEqual(client.request(path + '/document', {**fields, 'index': '3'})[0], 409)
        self.assertEqual(self.pdf_post(client, path, csrf)[0], 429)
        self.assertEqual(client.request(path + '/verify', {**fields, 'finish': '0'})[0], 200)
        self.assertEqual(client.request(path + '/document', {**fields, 'index': '3'})[0], 200)
        self.assertEqual(client.request(path + '/verify', {**fields, 'abandon': '1'})[0], 200)
        self.assertEqual(client.request(path + '/document', {**fields, 'index': '0'})[0], 200)
        self.assertEqual(self.rows('SELECT SUM(doc_count) AS n FROM pdf_export_events')[0]['n'], 4)
        client.request(path + '/release', fields)
        # The shared regression database may contain jobs owned by other tests/visitors.
        self.assertEqual(self.rows(f"SELECT COUNT(*) AS n FROM pdf_export_documents WHERE job_token = '{lease}'")[0]['n'], 0)

    def test_pdf_resource_budgets_and_failed_job_cleanup(self):
        share, _ = self.pdf_notebook(121)
        client, path, csrf = self.pdf_visitor(share)
        self.assertEqual(self.pdf_post(client, path, csrf)[0], 413)
        self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)
        for markdown in ['x' * (2097152 + 1), '![img](assets/a.png)\n\n' * 201]:
            share = self.share(markdown=markdown)
            client, path, csrf = self.pdf_visitor(share)
            status, _, body = self.pdf_post(client, path, csrf)
            if status == 200:
                status, _, body = self.pdf_document(client, path, csrf, self.pdf_lease(body))
            self.assertEqual(status, 413, body[:200])
            self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)
        share = self.share(markdown='Small content')
        client, path, csrf = self.pdf_visitor(share)
        self.rows(f"INSERT INTO share_assets(share_id, doc_id, asset_path, file_path, size_bytes, created_at) VALUES ({int(share['id'])}, '{self.name}', 'assets/large.png', 'unused.png', 52428801, '2026-01-01')")
        self.assertEqual(self.pdf_post(client, path, csrf)[0], 413)
        self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)
