"""Release regressions using disposable shares and independent PHP workers."""
from pathlib import Path
import subprocess
import time


class PdfReleaseTests:
    def pdf_workers(self, share, count, mode='concurrent'):
        if self.container:
            command = ['docker', 'exec', '--user', 'www-data', self.container, 'php', '/tmp/pdf-race.php', '/var/www/html/bootstrap.php']
        elif self.php_executable:
            command = [self.php_executable, str(Path(__file__).with_name('pdf-race.php')), self.bootstrap_path]
        else:
            self.skipTest('Independent PHP workers require the local CLI')
        barrier = str(time.time() + 1.5)
        cookie = getattr(self, 'pdf_worker_cookie', '') if mode in ['rate', 'same-visitor'] else ''
        workers = [subprocess.Popen([*command, str(share['id']), str(i + 1), barrier, mode, cookie],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(count)]
        results = []
        for worker in workers:
            output, errors = worker.communicate(timeout=25)
            self.assertEqual(worker.returncode, 0, errors)
            self.assertEqual(errors, b'')
            results.append(output.decode())
        return results

    def test_pdf_release_repeated_atomic_quota_races(self):
        share = self.share()
        self.pdf_visitor(share)
        self.rows("UPDATE settings SET value = '5' WHERE key = 'pdf_export_requests'")
        for _ in range(3):
            self.rows('DELETE FROM pdf_export_events')
            self.rows('DELETE FROM pdf_export_leases')
            results = self.pdf_workers(share, 12, 'rate')
            self.assertEqual(results.count('accepted'), 5, results)
            self.assertEqual(results.count('limited'), 7, results)
            self.assertEqual(self.rows('SELECT SUM(doc_count) AS n FROM pdf_export_events')[0]['n'], 5)
            self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)
        self.rows('DELETE FROM pdf_export_events')
        self.rows("UPDATE settings SET value = '120' WHERE key = 'pdf_export_requests'")

    def test_pdf_release_parallel_legacy_upgrade_and_admission(self):
        share = self.share()
        self.pdf_visitor(share)
        self.rows("DELETE FROM settings WHERE key = 'pdf_export_requests'")
        self.rows("UPDATE settings SET value = '600' WHERE key = 'pdf_export_window_seconds'")
        self.rows("INSERT INTO settings(key, value, updated_at) VALUES ('pdf_export_ip_requests', '10', '2026-01-01'), ('pdf_export_fingerprint_requests', '6', '2026-01-01')")
        results = self.pdf_workers(share, 12)
        self.assertEqual(results.count('accepted'), 4, results)
        self.assertEqual(results.count('limited'), 8, results)
        values = {row['key']: row['value'] for row in self.rows("SELECT key, value FROM settings WHERE key IN ('pdf_export_requests', 'pdf_export_window_seconds', 'pdf_export_ip_requests', 'pdf_export_fingerprint_requests')")}
        self.assertEqual(values, {'pdf_export_requests': '6', 'pdf_export_window_seconds': '3600'})
        self.rows("UPDATE settings SET value = '120' WHERE key = 'pdf_export_requests'")
        self.rows('DELETE FROM pdf_export_leases')
        self.rows('DELETE FROM pdf_export_events')

    def test_pdf_release_tree_overflow_and_exact_batch_boundary(self):
        docs = [{'docId': self.name + str(i), 'title': '边界文档' + str(i), 'markdown': 'RELEASE_BOUNDARY_' + str(i),
                 'parentId': self.name + '0' if i else ''} for i in range(31)]
        share = self.api('shares/notebook', {'notebookId': self.name, 'title': 'Boundary', 'docs': docs})['share']
        visitor, path, csrf = self.pdf_visitor(share)
        self.assertEqual(self.pdf_post(visitor, path, csrf, scope='tree', doc_id=docs[0]['docId'])[0], 413)
        selected = {f'doc_ids[{i}]': docs[i]['docId'] for i in range(30)}
        status, _, body = self.pdf_post(visitor, path, csrf, scope='selected', **selected)
        self.assertEqual(status, 200, body[:300])
        self.assertEqual(body.count(b'data-pdf-doc='), 30)
        self.assertNotIn(b'RELEASE_BOUNDARY_30', body)
        visitor.request(path + '/release', {'csrf': csrf, 'lease': self.pdf_lease(body)})
        self.assertEqual(self.pdf_post(visitor, path, csrf, scope='single', doc_id="' OR 1=1 --")[0], 404)
        self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)

    def test_pdf_release_lease_bound_to_share_and_deleted_documents(self):
        share, docs = self.pdf_notebook(2)
        visitor, path, csrf = self.pdf_visitor(share)
        body = self.pdf_post(visitor, path, csrf)[2]
        lease = self.pdf_lease(body)
        other = self.share(markdown='OTHER_SCOPE_RELEASE_SECRET')
        other_path = '/s/' + other['slug'] + '/export'
        self.assertEqual(visitor.request(other_path + '/verify', {'csrf': csrf, 'lease': lease})[0], 410)
        visitor.request(path + '/release', {'csrf': csrf, 'lease': lease})
        self.api('shares/notebook', {'notebookId': self.name, 'title': 'After update', 'docs': docs[:1]})
        status, _, body = self.pdf_post(visitor, path, csrf, scope='selected', **{'doc_ids[0]': docs[0]['docId'], 'doc_ids[1]': docs[1]['docId']})
        self.assertEqual(status, 404, body[:300])
        self.assertNotIn(b'OTHER_SCOPE_RELEASE_SECRET', body)

    def test_pdf_release_expansion_budget_and_advanced_retention(self):
        share = self.share(markdown='&' * 10000)
        visitor, path, csrf = self.pdf_visitor(share)
        admin = self.admin()
        original = self.pdf_admin_form(admin)
        try:
            changed = {**original, 'limits[max_html_bytes]': '0.0625'}
            self.assertEqual(admin.request('/admin/pdf-export-settings', changed)[0], 302)
            self.assertEqual(self.pdf_post(visitor, path, csrf)[0], 413)
            self.assertEqual(self.rows('SELECT COUNT(*) AS n FROM pdf_export_leases')[0]['n'], 0)
            form = self.pdf_admin_form(admin)
            self.assertEqual(form['limits[max_html_bytes]'], '0.0625')
            form['limits[requests]'] = '4'
            self.assertEqual(admin.request('/admin/pdf-export-settings', form)[0], 302)
            self.assertEqual(self.pdf_admin_form(admin)['limits[max_html_bytes]'], '0.0625')
        finally:
            admin.request('/admin/pdf-export-settings', original)
            self.rows('DELETE FROM pdf_export_events')
