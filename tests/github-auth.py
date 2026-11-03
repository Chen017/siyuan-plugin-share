"""Isolated OAuth migration tests with a deterministic GitHub HTTP fixture."""
import argparse
import http.client
import json
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--php', required=True)
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='siyuan-oauth-') as temp:
    work = Path(temp)
    app = work / 'app'
    shutil.copytree(ROOT / 'php-site', app, ignore=shutil.ignore_patterns('config.php', 'storage', 'uploads'))
    (app / 'storage').mkdir()
    (app / 'uploads').mkdir()
    (work / 'sessions').mkdir()
    oauth_file = work / 'oauth.json'
    oauth = {'client_id': 'client_fixture', 'client_secret': 'secret_fixture', 'callback_url': 'https://note.example/auth/github/callback', 'github_user_id': '120784851', 'local_user_id': '1'}
    oauth_file.write_text(json.dumps(oauth), encoding='utf-8')
    (app / 'config.php').write_text("<?php return ['chunk_cleanup_probability'=>0, 'github_oauth_config'=>" + json.dumps(str(oauth_file).replace('\\', '/')) + "];", encoding='utf-8')
    # Only the isolated test copy replaces the HTTP transport. All callback,
    # identity, session and database logic remains the production code.
    auth_path = app / 'github-auth.php'
    source = auth_path.read_text(encoding='utf-8')
    start = source.index('function github_http_json(')
    end = source.index('\nfunction github_fail()', start)
    fixture = '''function github_http_json(string $url, array $headers, ?array $post = null): ?array {
    if ($post !== null) {
        if (($post['code_verifier'] ?? '') === '' || ($post['client_secret'] ?? '') !== 'secret_fixture') return null;
        return ['access_token' => ($post['code'] === 'wrong-user' ? 'wrong_user' : 'right_user')];
    }
    return ['id' => in_array('Authorization: Bearer right_user', $headers, true) ? 120784851 : 999];
}
'''
    auth_path.write_text(source[:start] + fixture + source[end:], encoding='utf-8')
    router = work / 'router.php'
    router.write_text("<?php $_SERVER['SCRIPT_NAME']='/index.php'; require " + json.dumps(str(app / 'index.php').replace('\\', '/')) + ";", encoding='utf-8')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    log = (work / 'server.log').open('w+')
    process = subprocess.Popen([args.php, '-d', 'display_errors=0', '-d', 'error_reporting=32767', '-d', 'session.save_path=' + str(work / 'sessions'), '-S', f'127.0.0.1:{port}', str(router)], stdout=log, stderr=log)
    cookie = ''

    def request(path, body=None, old_cookie=None):
        global cookie
        headers = {'Cookie': cookie if old_cookie is None else old_cookie}
        if body is not None:
            body = urllib.parse.urlencode(body)
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        connection.request('POST' if body is not None else 'GET', path, body, headers)
        response = connection.getresponse()
        data = response.read().decode()
        received = response.getheader('Set-Cookie')
        if received:
            assert 'HttpOnly' in received and 'SameSite=Lax' in received, received
            if oauth_file.exists(): assert 'secure' in received.lower(), received
            cookie = received.split(';', 1)[0]
        result = (response.status, response.getheader('Location'), data)
        connection.close()
        return result

    def begin():
        status, location, _ = request('/auth/github')
        assert status == 302 and location.startswith('https://github.com/login/oauth/authorize?')
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
        assert params['code_challenge_method'] == ['S256'] and 'scope' not in params
        return params['state'][0]

    def callback(state, code='ok'):
        return request('/auth/github/callback?' + urllib.parse.urlencode({'state': state, 'code': code}))

    try:
        for _ in range(60):
            try:
                status, _, page = request('/login')
                break
            except OSError:
                time.sleep(.1)
        assert status == 200 and 'Sign in with GitHub' in page and 'name="password"' in page
        db = sqlite3.connect(app / 'storage/app.db')
        db.execute("UPDATE users SET password_hash='$2y$10$nxAGHI1ZkpshiwzuMgwQDu7PYcOgGdhTK8FdVri6aUdfuYpHyQ5hS', must_change_password=0 WHERE id=1")
        db.commit()
        csrf = re.search(r'name="csrf" value="([^"]+)', page)[1]
        assert request('/login', {'csrf': csrf, 'username': 'admin', 'password': 'Test-PHP83!pass'})[:2] == (302, '/dashboard')
        password_cookie = cookie
        cookie = ''
        state = begin()
        assert callback('invalid')[1] == '/login'
        assert callback(state)[1] == '/login'  # one-time state
        state = begin()
        assert callback(state, 'wrong-user')[1] == '/login'
        assert request('/dashboard')[1] == '/login'
        state = begin()
        assert callback(state)[1] == '/dashboard'
        github_cookie = cookie
        assert request('/dashboard')[0] == 200
        assert callback(state)[1] == '/login'  # cannot replay successful state
        db.execute("INSERT INTO settings(key,value,updated_at) VALUES ('admin_auth_mode','github',datetime('now'))")
        db.commit()
        assert request('/dashboard', old_cookie=password_cookie)[1] == '/login'
        cookie = github_cookie
        assert request('/dashboard')[0] == 200
        status, _, page = request('/login', old_cookie='')
        assert status == 200 and 'name="password"' not in page
        csrf = re.search(r'name="csrf" value="([^"]+)', page)
        assert csrf is None
        assert request('/login', {'csrf': 'invalid', 'username': 'admin', 'password': 'Test-PHP83!pass'})[0] == 400
        cookie = github_cookie
        db.execute('UPDATE users SET disabled=1 WHERE id=1')
        db.commit()
        assert request('/dashboard')[1] == '/login'
        db.execute('UPDATE users SET disabled=0 WHERE id=1')
        db.commit()
        oauth['client_secret'] = 'rotated_fixture'
        oauth_file.write_text(json.dumps(oauth), encoding='utf-8')
        assert request('/dashboard', old_cookie=github_cookie)[1] == '/login'
        oauth_file.unlink()
        assert request('/dashboard', old_cookie=github_cookie)[1] == '/login'
        status, _, page = request('/login', old_cookie='')
        assert status == 200 and 'unavailable' in page and 'name="password"' not in page
        assert 'secret_fixture' not in page
        print('GitHub OAuth state, identity, sessions, migration and fail-closed tests passed')
    finally:
        if 'db' in locals(): db.close()
        process.terminate()
        process.wait(timeout=10)
        log.seek(0)
        text = log.read()
        log.close()
        if re.search(r'PHP (?:Warning|Deprecated|Fatal error|Parse error|Notice)', text):
            raise AssertionError(text)
