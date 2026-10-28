"""Regression coverage for the seven selected audit fixes; disposable data only."""
import hashlib
import json
import subprocess
import time
import uuid


class SelectedFixTests:
    def fixes_php_command(self, code, *args):
        code = "$_SERVER['SCRIPT_NAME']='/index.php'; ini_set('session.save_path',dirname($argv[1]).'/storage'); require $argv[1]; " + code
        if self.container:
            return ['docker', 'exec', '--user', 'www-data', self.container, 'php', '-r', code, '/var/www/html/bootstrap.php', *map(str, args)]
        return [self.php_executable, '-r', code, self.bootstrap_path, *map(str, args)]

    def fixes_php(self, code, *args):
        result = subprocess.run(self.fixes_php_command(code, *args), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def asset_share(self, doc_id, notebook=False):
        meta = {'title': 'Attachment rollback', 'docs': [{'docId': doc_id, 'title': 'Doc', 'markdown': 'OLD_BODY'}]}
        meta['notebookId' if notebook else 'docId'] = doc_id
        status, _, body = self.client.request('/api/v1/shares/' + ('notebook' if notebook else 'doc'),
            {'metadata': json.dumps(meta), 'assetPaths[]': 'assets/keep.txt'}, {'X-Api-Key': self.key},
            files={'assets[]': ('keep.txt', b'OLD_ATTACHMENT')})
        self.assertEqual(status, 200, body)
        return json.loads(body)['data']['share']

    def test_fixes_slug_validation_and_deleted_reservation(self):
        slug = uuid.uuid4().hex[:12]
        share = self.share(slug=slug)
        self.assertEqual(share['slug'], slug)
        for bad in ['abc', 'a' * 33, '../escape', 'has-dash']:
            self.api('shares/doc', {'docId': self.name + bad, 'markdown': 'body', 'slug': bad}, status=400)
        self.api('shares/access/update', {'shareId': share['id'], 'slug': slug + 'new'})
        self.api('shares/delete', {'shareId': share['id']})
        self.api('shares/doc', {'docId': self.name + 'other', 'markdown': 'body', 'slug': slug + 'new'}, status=409)

    def test_fixes_stale_upload_cannot_undo_access_or_deletion(self):
        for notebook in [False, True]:
            with self.subTest(notebook=notebook):
                doc = self.name + str(notebook)
                kind = 'notebook' if notebook else 'doc'
                meta = {'notebookId' if notebook else 'docId': doc,
                        'docs': [{'docId': doc, 'markdown': 'OLD_BODY'}]}
                share = self.api('shares/' + kind, meta)['share']
                init = self.api('shares/' + kind + '/init', {'metadata': {**meta, 'docs': [{'docId': doc, 'markdown': 'NEW_BODY'}]}})
                expires = int(time.time()) + 3600
                self.api('shares/access/update', {'shareId': share['id'], 'password': 'KeepSecret!', 'expiresAt': expires, 'visitorLimit': 2})
                self.api('shares/upload/complete', {'uploadId': init['uploadId']}, status=409)
                row = self.rows(f"SELECT password_hash,expires_at FROM shares WHERE id={int(share['id'])}")[0]
                self.assertTrue(row['password_hash'])
                self.assertEqual(row['expires_at'], expires)
                self.assertNotIn(b'OLD_BODY', self.client.__class__(self.base).request('/s/' + share['slug'])[2])
                self.api('shares/upload/cancel', {'uploadId': init['uploadId']})
                init = self.api('shares/' + kind + '/init', {'metadata': meta})
                self.api('shares/delete', {'shareId': share['id']})
                self.api('shares/upload/complete', {'uploadId': init['uploadId']}, status=409)
                self.assertEqual(self.client.__class__(self.base).request('/s/' + share['slug'])[0], 404)
                fresh_meta = {**meta, 'notebookId' if notebook else 'docId': doc + 'fresh'}
                first = self.api('shares/' + kind + '/init', {'metadata': fresh_meta})
                second = self.api('shares/' + kind + '/init', {'metadata': fresh_meta})
                self.api('shares/upload/complete', {'uploadId': first['uploadId']})
                self.api('shares/upload/complete', {'uploadId': second['uploadId']}, status=409)

    def test_fixes_file_rollback_and_retry_full_incremental_and_direct(self):
        for mode in ['full', 'incremental', 'direct-doc', 'direct-notebook']:
            with self.subTest(mode=mode):
                doc = self.name + mode
                share = self.asset_share(doc, notebook=mode == 'direct-notebook')
                sid = int(share['id'])
                before = self.rows(f'SELECT file_path FROM share_assets WHERE share_id={sid}')[0]['file_path']
                files_before = self.fixes_php("echo json_encode(array_values(array_filter(iterator_to_array(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($config['uploads_dir'].'/shares/'.$argv[2],FilesystemIterator::SKIP_DOTS))),fn($p)=>$p->isFile())));", sid)
                payload = {'docId': doc, 'docs': [{'docId': doc, 'markdown': 'NEW_BODY'}]}
                if mode == 'direct-notebook':
                    payload = {'notebookId': doc, 'docs': [{'docId': doc, 'markdown': 'NEW_BODY'}]}
                data = b'NEW_ATTACHMENT'
                if mode in ['full', 'incremental']:
                    if mode == 'incremental': payload['incremental'] = {'enabled': True}
                    init = self.api('shares/doc/init', {'metadata': payload, 'assets': [{'path': 'assets/keep.txt', 'size': len(data)}]})
                    status, _, body = self.client.request('/api/v1/shares/asset/chunk',
                        {'uploadId': init['uploadId'], 'assetPath': 'assets/keep.txt', 'chunkIndex': 0, 'totalChunks': 1},
                        {'X-Api-Key': self.key}, files={'chunk': ('chunk', data)})
                    self.assertEqual(status, 200, body)
                self.rows(f"CREATE TRIGGER injected_write_failure BEFORE INSERT ON share_assets WHEN NEW.share_id={sid} BEGIN SELECT RAISE(ABORT,'synthetic asset insertion failure'); END")
                try:
                    if mode in ['full', 'incremental']:
                        self.api('shares/upload/complete', {'uploadId': init['uploadId']}, status=500)
                    else:
                        status, _, _ = self.client.request('/api/v1/shares/' + ('notebook' if mode.endswith('notebook') else 'doc'),
                            {'metadata': json.dumps(payload), 'assetPaths[]': 'assets/keep.txt'}, {'X-Api-Key': self.key},
                            files={'assets[]': ('keep.txt', data)})
                        self.assertEqual(status, 500)
                    self.assertEqual(self.rows(f'SELECT file_path FROM share_assets WHERE share_id={sid}')[0]['file_path'], before)
                    visitor = self.client.__class__(self.base)
                    self.assertEqual(visitor.request('/s/' + share['slug'] + '/res/assets/keep.txt')[2], b'OLD_ATTACHMENT')
                    self.assertEqual(self.rows(f'SELECT markdown FROM share_docs WHERE share_id={sid}')[0]['markdown'], 'OLD_BODY')
                    remaining = self.fixes_php("$n=0; foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($config['uploads_dir'].'/shares/'.$argv[2],FilesystemIterator::SKIP_DOTS)) as $p)if($p->isFile())$n++; echo json_encode($n);", sid)
                    self.assertEqual(remaining, len(files_before), 'Failed generation must be removed')
                finally:
                    self.rows('DROP TRIGGER injected_write_failure')
                if mode in ['full', 'incremental']:
                    self.api('shares/upload/complete', {'uploadId': init['uploadId']})
                    self.assertEqual(visitor.request('/s/' + share['slug'] + '/res/assets/keep.txt')[2], data)
                    self.assertEqual(self.rows(f'SELECT markdown FROM share_docs WHERE share_id={sid}')[0]['markdown'], 'NEW_BODY')

    def test_fixes_staging_expiry_lock_and_pending_budget(self):
        init = self.api('shares/doc/init', {'docId': self.name, 'markdown': 'staged'})
        upload = init['uploadId']
        self.rows(f"UPDATE share_uploads SET updated_at='2000-01-01 00:00:00' WHERE upload_id='{upload}'")
        result = self.fixes_php("$id=$argv[2];$l=lock_upload_session($id);cleanup_stale_uploads(60,1000);$q=db()->prepare('SELECT COUNT(*) FROM share_uploads WHERE upload_id=?');$q->execute([$id]);$before=(int)$q->fetchColumn();fclose($l);cleanup_stale_uploads(60,1000);$q->execute([$id]);echo json_encode([$before,(int)$q->fetchColumn()]);", upload)
        self.assertEqual(result, [1, 0])
        self.assertEqual(self.rows(f"SELECT id FROM share_upload_docs WHERE upload_id='{upload}'"), [])
        ids = []
        try:
            for i in range(32):
                ids.append(self.api('shares/doc/init', {'docId': self.name + str(i), 'markdown': 'pending'})['uploadId'])
            self.api('shares/doc/init', {'docId': self.name + 'over', 'markdown': 'pending'}, status=413)
            self.api('shares/upload/cancel', {'uploadId': ids.pop()})
            ids.append(self.api('shares/doc/init', {'docId': self.name + 'aftercancel', 'markdown': 'pending'})['uploadId'])
        finally:
            for pending in ids: self.api('shares/upload/cancel', {'uploadId': pending})

    def test_fixes_chunk_declared_size_and_hash(self):
        init = self.api('shares/doc/init', {'docId': self.name, 'markdown': 'doc', 'assets': [{'path': 'assets/tiny', 'size': 1, 'hash': hashlib.sha256(b'A').hexdigest()}]})
        fields = {'uploadId': init['uploadId'], 'assetPath': 'assets/tiny', 'chunkIndex': 0, 'totalChunks': 1}
        self.assertEqual(self.client.request('/api/v1/shares/asset/chunk', fields, {'X-Api-Key': self.key}, files={'chunk': ('chunk', b'AB')})[0], 413)
        self.assertEqual(self.client.request('/api/v1/shares/asset/chunk', fields, {'X-Api-Key': self.key}, files={'chunk': ('chunk', b'B')})[0], 200)
        self.api('shares/upload/complete', {'uploadId': init['uploadId']}, status=400)

    def test_fixes_orphan_generation_cleanup_preserves_published_and_active(self):
        share = self.asset_share(self.name)
        result = self.fixes_php("""
            $stmt=db()->prepare('SELECT file_path FROM share_assets WHERE share_id=?');$stmt->execute([$argv[2]]);
            $file=$config['uploads_dir'].'/'.$stmt->fetchColumn();$generation=dirname(dirname($file));touch($generation,946684800);
            $parent=dirname($generation);$orphan=$parent.'/'.str_repeat('f',32);ensure_dir($orphan);file_put_contents($orphan.'/bytes','orphan');touch($orphan,946684800);
            $active=$parent.'/'.str_repeat('e',32);ensure_dir($active);touch($active,946684800);$lock=lock_upload_session(str_repeat('e',32));
            cleanup_asset_generations(60,1000);$held=is_dir($active);fclose($lock);cleanup_asset_generations(60,1000);
            clearstatcache();echo json_encode([is_file($file),is_dir($orphan),$held,is_dir($active)]);
        """, share['id'])
        self.assertEqual(result, [True, False, True, False])

    def test_fixes_search_and_concurrent_read_access_without_admission(self):
        share = self.share(visitorLimit=1)
        path = '/s/' + share['slug']
        for _ in range(3):
            client = self.client.__class__(self.base)
            self.assertIn(b'PHP83_MARKER', client.request(path + '/search?q=PHP83_MARKER')[2])
            self.assertIn(b'PHP83_MARKER', client.request(path)[2])
        self.assertFalse(self.rows("SELECT name FROM sqlite_master WHERE name='share_visitors'"))
        barrier = time.time() + 1.5
        code = "db();while(microtime(true)<(float)$argv[4])usleep(1000);echo share_read_access_allowed((int)$argv[2])?'accepted':'denied';"
        workers = [subprocess.Popen(self.fixes_php_command(code, share['id'], i, barrier), stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(8)]
        for worker in workers:
            out, err = worker.communicate(timeout=20)
            self.assertEqual((worker.returncode, err, out), (0, b'', b'accepted'))
        self.api('shares/access/update', {'shareId': share['id'], 'password': 'New-Pass!', 'visitorLimit': 17})
        self.assertNotIn(b'PHP83_MARKER', client.request(path)[2])
        self.api('shares/access/update', {'shareId': share['id'], 'clearPassword': True, 'expiresAt': (int(time.time()) - 3600) * 1000})
        self.assertNotIn(b'PHP83_MARKER', client.request(path)[2])
        self.api('shares/access/update', {'shareId': share['id'], 'clearExpires': True, 'clearVisitorLimit': True})
        self.assertIn(b'PHP83_MARKER', client.request(path)[2])
