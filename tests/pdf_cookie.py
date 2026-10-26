"""Visitor-owned document budgets, exact-match CAPTCHA and cross-session mutex."""
from contextlib import contextmanager
import copy
import hashlib
import hmac
import json
from pathlib import Path
import subprocess
import time


class PdfCookieTests:
    @contextmanager
    def pdf_limit(self, number):
        original = self.rows("SELECT value FROM settings WHERE key = 'pdf_export_requests'")[0]['value']
        self.rows(f"UPDATE settings SET value = '{number}' WHERE key = 'pdf_export_requests'")
        try:
            yield
        finally:
            self.rows(f"UPDATE settings SET value = '{original}' WHERE key = 'pdf_export_requests'")

    def new_pdf_cookie_client(self, path, source=None):
        client = type(self.client)(self.base)
        if source:
            for cookie in source.cookies:
                if cookie.name == 'sps_pdf_visitor': client.cookies.set_cookie(copy.copy(cookie))
        token = self.csrf(client, path)
        return client, token

    def pdf_visitor_hash(self, client):
        value = next(cookie.value for cookie in client.cookies if cookie.name == 'sps_pdf_visitor')
        return hashlib.sha256(value.split('.')[0].encode()).hexdigest()

    def solve_pdf_captcha(self, client, path, csrf, fp='a' * 64):
        status, _, body = client.request(path + '/captcha', {'csrf': csrf, 'fingerprint': fp})
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertTrue(result['image'].startswith('data:image/png;base64,'))
        # Set a known answer in the disposable DB; production never exposes it.
        secret = self.rows("SELECT value FROM settings WHERE key = 'pdf_export_cookie_key'")[0]['value']
        answer_hash = hmac.new(secret.encode(), (result['token'] + ':ABCDE').encode(), hashlib.sha256).hexdigest()
        self.rows(f"UPDATE pdf_export_challenges SET answer_hash = '{answer_hash}' WHERE token = '{result['token']}'")
        payload = {'csrf': csrf, 'fingerprint': fp, 'token': result['token'], 'answer': 'abcde'}
        self.assertEqual(client.request(path + '/captcha-verify', payload)[0], 200)
        return payload

    def test_pdf_cookie_120_boundary_ip_change_and_recovery(self):
        share = self.share()
        visitor, path, csrf = self.pdf_visitor(share)
        identity = self.pdf_visitor_hash(visitor)
        with self.pdf_limit(120):
            self.rows(f"INSERT INTO pdf_export_events(ip_hash, fingerprint_hash, visitor_hash, created_at, doc_count) VALUES ('old-ip', 'fp', '{identity}', {int(time.time()) - 30}, 119)")
            status, _, body = self.pdf_post(visitor, path, csrf)
            self.assertEqual(status, 200, body)
            lease = self.pdf_lease(body)
            claim = {'csrf': csrf, 'lease': lease, 'index': '0'}
            self.assertEqual(visitor.request(path + '/claim', claim)[0], 200)
            self.assertEqual(visitor.request(path + '/claim', claim)[0], 200)  # retry does not count twice
            visitor.request(path + '/release', {'csrf': csrf, 'lease': lease})
            other_session, token = self.new_pdf_cookie_client(path, source=visitor)
            status, _, body = self.pdf_post(other_session, path, token, headers={'X-Real-IP': '203.0.113.88'}, fingerprint='b' * 64)
            self.assertEqual(status, 429, body)
            self.assertIn('预计'.encode(), body)
            self.assertEqual(self.rows(f"SELECT SUM(doc_count) AS n FROM pdf_export_events WHERE visitor_hash = '{identity}'")[0]['n'], 120)
            self.rows(f"INSERT INTO pdf_export_clearance VALUES ('{identity}', {int(time.time()) + 3600})")
            self.assertEqual(self.pdf_post(visitor, path, csrf)[0], 429)  # CAPTCHA never refills quota
            self.rows(f'UPDATE pdf_export_events SET created_at = {int(time.time()) - 3601}')
            self.assertEqual(self.pdf_post(visitor, path, csrf)[0], 200)

    def test_pdf_cookie_shared_ip_has_independent_quota_and_tasks(self):
        share = self.share()
        first, path, token_a = self.pdf_visitor(share)
        second, token_b = self.new_pdf_cookie_client(path)
        with self.pdf_limit(1):
            a = self.pdf_post(first, path, token_a)
            self.assertEqual(a[0], 200)
            lease_a = self.pdf_lease(a[2])
            self.assertEqual(first.request(path + '/claim', {'csrf': token_a, 'lease': lease_a, 'index': '0'})[0], 200)
            # Same actual peer IP, different Cookie and exact fingerprint.
            b = self.pdf_post(second, path, token_b, fingerprint='b' * 64)
            self.assertEqual(b[0], 200, b[2])
            lease_b = self.pdf_lease(b[2])
            self.assertEqual(second.request(path + '/claim', {'csrf': token_b, 'lease': lease_b, 'index': '0'})[0], 200)
            self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 2)
            for client, csrf, lease in [(first, token_a, lease_a), (second, token_b, lease_b)]:
                client.request(path + '/release', {'csrf': csrf, 'lease': lease})
            self.assertEqual(self.pdf_post(first, path, token_a)[0], 429)

    def test_pdf_cookie_exact_fingerprint_one_captcha_and_no_shared_quota(self):
        share = self.share()
        first, path, csrf_a = self.pdf_visitor(share)
        result = self.pdf_post(first, path, csrf_a)
        lease = self.pdf_lease(result[2])
        first.request(path + '/release', {'csrf': csrf_a, 'lease': lease})
        second, csrf_b = self.new_pdf_cookie_client(path)
        self.assertEqual(self.pdf_post(second, path, csrf_b)[0], 428)
        check = {'csrf': csrf_b, 'fingerprint': 'a' * 64}
        self.assertEqual(second.request(path + '/check', check)[0], 428)
        payload = self.solve_pdf_captcha(second, path, csrf_b)
        self.assertEqual(second.request(path + '/captcha-verify', payload)[0], 400)  # no replay
        for _ in range(3): self.assertEqual(second.request(path + '/check', check)[0], 200)
        copied, copied_csrf = self.new_pdf_cookie_client(path, source=second)
        self.assertEqual(copied.request(path + '/check', {'csrf': copied_csrf, 'fingerprint': 'a' * 64})[0], 200)
        self.assertEqual(first.request(path + '/check', {'csrf': csrf_a, 'fingerprint': 'a' * 64})[0], 200)
        result = self.pdf_post(second, path, csrf_b)
        self.assertEqual(result[0], 200, result[2])
        second.request(path + '/release', {'csrf': csrf_b, 'lease': self.pdf_lease(result[2])})
        # A one-character difference is not an exact match and requires no CAPTCHA.
        third, csrf_c = self.new_pdf_cookie_client(path)
        self.assertEqual(third.request(path + '/check', {'csrf': csrf_c, 'fingerprint': 'a' * 63 + 'b'})[0], 200)

    def test_pdf_cookie_captcha_wrong_expired_and_bounded_attempts(self):
        share = self.share()
        first, path, csrf_a = self.pdf_visitor(share)
        body = self.pdf_post(first, path, csrf_a)[2]
        first.request(path + '/release', {'csrf': csrf_a, 'lease': self.pdf_lease(body)})
        second, csrf = self.new_pdf_cookie_client(path)
        response = second.request(path + '/captcha', {'csrf': csrf, 'fingerprint': 'a' * 64})
        self.assertEqual(response[0], 200)
        token = json.loads(response[2])['token']
        self.rows(f"UPDATE pdf_export_challenges SET expires_at = 1 WHERE token = '{token}'")
        wrong = {'csrf': csrf, 'fingerprint': 'a' * 64, 'token': token, 'answer': 'WRONG'}
        for _ in range(10): self.assertEqual(second.request(path + '/captcha-verify', wrong)[0], 400)
        self.assertEqual(second.request(path + '/captcha-verify', wrong)[0], 429)
        self.assertEqual(second.request(path + '/captcha', {'csrf': csrf, 'fingerprint': 'a' * 64})[0], 429)
        self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_clearance')[0]['n'], 0)

    def test_pdf_cookie_task_mutex_across_sessions_is_atomic(self):
        share = self.share()
        self.pdf_visitor(share)
        results = self.pdf_workers(share, 12, 'same-visitor')
        self.assertEqual(results.count('accepted'), 1, results)
        self.assertEqual(results.count('limited'), 11, results)

    def test_pdf_cookie_renewal_is_bounded_and_expired_task_cannot_revive(self):
        visitor, path, csrf = self.pdf_visitor(self.share())
        response = self.pdf_post(visitor, path, csrf)
        lease = self.pdf_lease(response[2])
        payload = {'csrf': csrf, 'lease': lease, 'renew': '1'}
        self.assertEqual(visitor.request(path + '/verify', payload)[0], 200)
        record = self.rows(f"SELECT expires_at, created_at FROM pdf_export_leases WHERE token = '{lease}'")[0]
        self.assertLessEqual(record['expires_at'], int(time.time()) + 180)
        self.rows(f"UPDATE pdf_export_leases SET created_at = {int(time.time()) - 1801} WHERE token = '{lease}'")
        self.assertEqual(visitor.request(path + '/verify', payload)[0], 410)

    def test_pdf_cookie_admin_256_boundary_and_retains_saved_values(self):
        admin = self.admin()
        original = self.pdf_admin_form(admin)
        try:
            for number in [120, 256]:
                self.assertEqual(admin.request('/admin/pdf-export-settings', {**original, 'limits[requests]': str(number)})[0], 302)
                self.assertEqual(self.pdf_admin_form(admin)['limits[requests]'], str(number))
            self.assertEqual(admin.request('/admin/pdf-export-settings', {**original, 'limits[requests]': '257'})[0], 302)
            self.assertEqual(self.pdf_admin_form(admin)['limits[requests]'], '256')
        finally:
            admin.request('/admin/pdf-export-settings', original)

    def test_pdf_cookie_explicit_operator_setting_preserves_other_admin_values(self):
        before = self.rows('SELECT key, value FROM settings ORDER BY key')
        if self.container:
            subprocess.run(['docker', 'cp', str(Path(__file__).resolve().parents[1] / 'scripts/configure-pdf-limits.php'), self.container + ':/tmp/configure-pdf-limits.php'], check=True, capture_output=True)
            command = ['docker', 'exec', '--user', 'www-data', self.container, 'php', '/tmp/configure-pdf-limits.php', '/var/www/html']
        else:
            command = [self.php_executable, str(Path(__file__).resolve().parents[1] / 'scripts/configure-pdf-limits.php'), str(Path(self.bootstrap_path).parent)]
        try:
            result = subprocess.run([*command, '60', '120'], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.rows("SELECT value FROM settings WHERE key = 'pdf_export_requests'")[0]['value'], '120')
            result = subprocess.run([*command, '60', '257'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            after = self.rows('SELECT key, value FROM settings ORDER BY key')
            ignored = ['pdf_export_window_seconds', 'pdf_export_requests']
            self.assertEqual([r for r in before if r['key'] not in ignored], [r for r in after if r['key'] not in ignored])
        finally:
            for row in before:
                if row['key'] in ['pdf_export_window_seconds', 'pdf_export_requests']:
                    self.rows(f"UPDATE settings SET value = '{row['value']}' WHERE key = '{row['key']}'")

    def test_pdf_cookie_browser_long_document_download(self):
        if not self.browser:
            self.skipTest('Use --browser for long PDF rendering')
        parts = ['# LONG_START\n\n长文第一页，检验公式和分页。\n\n$$\\sum_{i=1}^n i=\\frac{n(n+1)}2$$']
        for index in range(80):
            parts.append(f'## Section {index + 1:03d}\n\n本段标记 SECTION_{index + 1:03d}。' + '这是用于跨页检查的中文正文，包含 inline math $x^2+y^2$ 与英文内容。' * 3)
        parts.append('## LONG_END\n\nLONG_TAIL_MARKER 最后一页内容必须完整保留。')
        share = self.share(markdown='\n\n'.join(parts))
        self.pdf_visitor(share)
        output = Path(__file__).resolve().parents[1] / '.test-output'
        output.mkdir(exist_ok=True)
        subprocess.run(['node', str(Path(__file__).with_name('pdf-long.cjs')), self.base + '/s/' + share['slug'], str(output)],
                       input=json.dumps({'cookie': self.pdf_worker_cookie}), text=True, check=True, timeout=210)
