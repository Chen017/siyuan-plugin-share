"""Website share editing must enforce the same access and revision rules as sync."""
import re



class AdminShareTests:
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

    def test_admin_share_editor_legacy_owner_and_slug(self):
        share = self.share()
        owner = self.name + '-legacy'
        self.create_actor(owner, role='user')
        legacy_id = self.rows("SELECT id FROM users WHERE username='" + owner + "'")[0]['id']
        self.rows(f"UPDATE shares SET user_id={legacy_id} WHERE id={share['id']}")
        admin = self.admin()
        path, fields = self.editor_fields(admin, share, slug='edit' + self.name.replace('_', ''), title='<Title & notes>')
        self.assertEqual(admin.request(path, fields)[0], 302)
        row = self.rows('SELECT * FROM shares WHERE id=' + str(share['id']))[0]
        self.assertEqual(row['user_id'], legacy_id)
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
