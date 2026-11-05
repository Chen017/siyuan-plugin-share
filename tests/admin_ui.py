"""Website share editing must enforce the same access and revision rules as sync."""
import json
import re
import subprocess
from pathlib import Path



class AdminShareTests:
    def test_explicit_public_https_configuration_preserves_other_settings(self):
        helper = Path(__file__).resolve().parents[1] / 'scripts/configure-public-url.php'
        original = self.rows('SELECT key,value FROM settings ORDER BY key')
        def run(url):
            if self.container:
                command = ['docker', 'exec', '-i', '--user', 'www-data', self.container, 'php', '/dev/stdin', '/var/www/html', url]
                return subprocess.run(command, input=helper.read_text(encoding='utf-8'), capture_output=True, text=True, timeout=20)
            return subprocess.run([self.php_executable, str(helper), str(Path(self.bootstrap_path).parent), url], capture_output=True, text=True, timeout=20)
        try:
            for invalid in ['http://unsafe.example', 'https://user:secret@example.org', 'https://example.org/?q=1', 'https://example.org/#fragment']:
                rejected = run(invalid)
                self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(self.rows('SELECT key,value FROM settings ORDER BY key'), original)
            result = run('https://note.etalib.space')
            self.assertEqual(result.returncode, 0, result.stderr)
            after = self.rows('SELECT key,value FROM settings ORDER BY key')
            self.assertEqual([r for r in after if r['key'] != 'site_base_url'], [r for r in original if r['key'] != 'site_base_url'])
            share = self.share()
            page = self.admin().request('/admin/share?share_id=' + str(share['id']))[2]
            self.assertIn(('https://note.etalib.space/s/' + share['slug']).encode(), page)
        finally:
            previous = next(row['value'] for row in original if row['key'] == 'site_base_url')
            self.rows("UPDATE settings SET value='" + previous.replace("'", "''") + "' WHERE key='site_base_url'")

    def test_soft_delete_named_undo_and_permanent_confirmation(self):
        share = self.share(title='Undo <fixture>')
        admin = self.admin()
        page = admin.request('/dashboard')[2]
        token = re.search(rb'name="csrf" value="([^"]+)"', page)[1].decode()
        fields = {'csrf': token, 'share_id': share['id']}
        self.assertEqual(admin.request('/admin/share-delete', fields)[0], 302)
        notice = admin.request('/dashboard')[2]
        self.assertIn(b'data-notice-persistent', notice)
        self.assertIn(b'Undo &lt;fixture&gt;', notice)
        self.assertIn(b'>Undo</button>', notice)
        self.assertIn(b'The share link is inactive', notice)
        deleted = admin.request('/dashboard?status=deleted')[2]
        self.assertIn(b'This cannot be undone.', deleted)
        self.assertIn(b'Undo &lt;fixture&gt;', deleted)
        self.assertEqual(admin.request('/admin/share-restore', fields)[0], 302)
        self.assertIn(b'Share restored.', admin.request('/dashboard')[2])
        self.assertIn(b'PHP83_MARKER', type(self.client)(self.base).request('/s/' + share['slug'])[2])

    def test_english_site_brand_and_password_gate(self):
        admin = self.admin()
        status, _, body = admin.request('/dashboard')
        self.assertEqual(status, 200)
        self.assertIn(b"<html lang='en'>", body)
        self.assertIn(b'SiYuan Share</title>', body)
        share = self.share(password='Gate-Password!')
        visitor = type(self.client)(self.base)
        _, _, gate = visitor.request('/s/' + share['slug'])
        self.assertIn(b'<label for="share-password">Share password</label>', gate)
        self.assertIn(b'data-share-password-toggle', gate)
        _, _, error = visitor.request('/s/' + share['slug'], {'share_password': 'wrong'})
        self.assertIn(b'aria-describedby="share-password-error"', error)
        self.assertIn(b'id="share-password-error" role="alert"', error)

    def editor_fields(self, client, share, **changes):
        path = '/admin/share?share_id=' + str(share['id'])
        status, _, body = client.request(path)
        self.assertEqual(status, 200)
        fields = {'csrf': re.search(rb'name="csrf" value="([^"]+)"', body)[1].decode(),
                  'revision': re.search(rb'name="revision" value="([^"]+)"', body)[1].decode(),
                  'title': self.rows('SELECT title FROM shares WHERE id=' + str(share['id']))[0]['title'], 'slug': share['slug'], 'expires_at': '',
                  'password_mode': 'keep'}
        return path, {**fields, **changes}

    def test_admin_share_editor_access_and_password_lifecycle(self):
        share = self.share(password='Old-Share!')
        visitor = type(self.client)(self.base)
        share_path = '/s/' + share['slug']
        visitor.request(share_path, {'share_password': 'Old-Share!'})
        self.assertIn(b'PHP83_MARKER', visitor.request(share_path)[2])
        admin = self.admin()
        path, fields = self.editor_fields(admin, share, password_mode='set', password='New-Share!', expires_at='2030-12-31T23:59')
        self.assertEqual(type(self.client)(self.base).request(path)[0], 302)
        self.assertEqual(type(self.client)(self.base).request(path, fields)[0], 302)
        self.assertEqual(admin.request(path, {**fields, 'csrf': 'invalid'})[0], 400)
        self.assertEqual(admin.request(path, fields)[0], 302)
        row = self.rows('SELECT * FROM shares WHERE id=' + str(share['id']))[0]
        self.assertNotIn('visitor_limit', row)
        self.assertIsNotNone(row['expires_at'])
        self.assertEqual(row['revision'], int(fields['revision']) + 1)
        self.assertNotIn('New-Share!', row['password_hash'])
        self.assertNotIn(b'PHP83_MARKER', visitor.request(share_path)[2])
        self.assertEqual(visitor.request(share_path, {'share_password': 'New-Share!'})[0], 302)
        self.assertIn(b'PHP83_MARKER', visitor.request(share_path)[2])
        page = admin.request(path)[2]
        self.assertNotIn(b'New-Share!', page)
        self.assertNotIn(row['password_hash'].encode(), page)
        path, fields = self.editor_fields(admin, share, password_mode='remove')
        self.assertEqual(admin.request(path, fields)[0], 302)
        row = self.rows('SELECT * FROM shares WHERE id=' + str(share['id']))[0]
        self.assertIsNone(row['password_hash'])
        self.assertIsNone(row['expires_at'])
        self.assertIn(b'PHP83_MARKER', type(self.client)(self.base).request(share_path)[2])

    def test_admin_share_editor_conflicts_and_validation(self):
        share = self.share()
        reserved = self.share(docId=self.name + '-reserved')
        self.api('shares/delete', {'shareId': reserved['id']})
        admin = self.admin()
        path, fields = self.editor_fields(admin, share)
        before = self.rows('SELECT * FROM shares WHERE id=' + str(share['id']))[0]
        for invalid in [{'slug': reserved['slug']}, {'slug': 'bad/path'}, {'slug': ''},
                        {'expires_at': '2030-02-31T12:00'}, {'password_mode': 'unknown'},
                        {'password_mode': 'set', 'password': ''}]:
            self.assertEqual(admin.request(path, {**fields, **invalid})[0], 400, invalid)
            self.assertEqual(self.rows('SELECT * FROM shares WHERE id=' + str(share['id']))[0], before)
        self.api('shares/access/update', {'shareId': share['id'], 'expiresAt': 1900000000000})
        self.assertEqual(admin.request(path, fields)[0], 409)
        self.assertEqual(self.rows('SELECT expires_at FROM shares WHERE id=' + str(share['id']))[0]['expires_at'], 1900000000)
        # Stale form re-submission is still stale, rather than silently rebased.
        self.assertEqual(admin.request(path, fields)[0], 409)
        self.api('shares/delete', {'shareId': share['id']})
        self.assertEqual(admin.request(path)[0], 404)
        self.assertEqual(admin.request(path, fields)[0], 404)

    def test_admin_share_editor_owner_and_slug(self):
        share = self.share()
        owner_id = self.rows('SELECT user_id FROM shares WHERE id=' + str(share['id']))[0]['user_id']
        admin = self.admin()
        path, fields = self.editor_fields(admin, share, slug='edit' + self.name.replace('_', ''), title='<Title & notes>')
        self.assertEqual(admin.request(path, fields)[0], 302)
        row = self.rows('SELECT * FROM shares WHERE id=' + str(share['id']))[0]
        self.assertEqual(row['user_id'], owner_id)
        self.assertEqual(row['slug'], fields['slug'])
        self.assertIn(b'&lt;Title &amp; notes&gt;', admin.request(path)[2])
        self.assertIn(b'PHP83_MARKER', type(self.client)(self.base).request('/s/' + fields['slug'])[2])
        self.assertNotIn(b'PHP83_MARKER', type(self.client)(self.base).request('/s/' + share['slug'])[2])

    def test_admin_shares_all_results_and_retired_fields(self):
        for n in range(13):
            self.share(docId=self.name + '-card-' + str(n), title=self.name + '-card-' + str(n))
        page = self.client.request('/dashboard?share_search=' + self.name + '-card-&share_page=99&share_size=1')[2]
        self.assertEqual(page.count(b'class="share-card"'), 13)
        self.assertNotIn(b'Page ', page)
        self.assertNotIn(b'Visitors', page)
        self.assertIn(b'controls.js', page)
        self.assertIn(b'data-confirm-message', self.client.request('/admin')[2])

    def test_admin_image_compression_settings_and_action(self):
        admin = self.admin()
        page = admin.request('/admin')[2]
        self.assertIn(b'id="image-compression"', page)
        self.assertIn(b'Image compression', page)
        self.assertIn(b'Check &amp; compress', page)

        code, _, data = admin.request('/admin/images/status')
        self.assertEqual(code, 200)
        status = json.loads(data.decode('utf-8'))
        payload = status.get('data', status)
        self.assertIn('total_images', payload)
        self.assertIn('compressed_images', payload)
        self.assertIn('pending_images', payload)
        self.assertIn('tools', payload)
        self.assertIn('background_task', payload)

        token = re.search(rb'name="csrf" value="([^"]+)"', page)[1].decode()
        resp_code, _, _ = admin.request('/admin/images/compress', {'csrf': token})
        self.assertEqual(resp_code, 302)
        after_page = admin.request('/admin')[2]
        self.assertIn(b'Compression complete', after_page)

        # Test stop endpoint
        stop_code, _, _ = admin.request('/admin/images/compress-stop', {'csrf': token})
        self.assertEqual(stop_code, 302)
