"""End-to-end integration tests for the read-only MCP server and OAuth 2.1 flow.

Usage:
    python3 tests/mcp.py --php /path/to/php
    python3 tests/mcp.py --docker siyuan-share:php83-test
"""
import argparse
import base64
from contextlib import closing
import hashlib
import http.cookiejar
import json
import os
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

ROOT = Path(__file__).resolve().parents[1]
ENV_INTERNAL_TOKEN = 'env-override-internal-token-64hex'
CONFIG = """<?php
return [
    'chunk_cleanup_probability' => 0,
    'mcp_internal_token' => 'test-internal-gateway-token-64hex',
    'mcp_internal_user_id' => 1,
];
"""
DIAGNOSTICS = re.compile(
    r'(?:PHP (?:Warning|Deprecated|Fatal error|Parse error|Notice)\b|<b>(?:Warning|Deprecated|Fatal error|Parse error|Notice)</b>:|(?:Warning|Deprecated|Fatal error|Parse error|Notice):[^\n]* in [^\n]+\.php on line \d+)'
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpClient:
    def __init__(self, base: str, use_cookies: bool = True):
        self.base = base.rstrip('/')
        self.cookies = http.cookiejar.CookieJar()
        handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
        if use_cookies:
            handlers.append(urllib.request.HTTPCookieProcessor(self.cookies))
        self.opener = urllib.request.build_opener(*handlers)

    def request(self, path: str, data=None, headers=None, method=None):
        hdrs = dict(headers or {})
        body_bytes = None
        if isinstance(data, dict):
            body_bytes = urllib.parse.urlencode(data).encode('utf-8')
            hdrs.setdefault('Content-Type', 'application/x-www-form-urlencoded')
        elif isinstance(data, (bytes, bytearray)):
            body_bytes = bytes(data)
        elif isinstance(data, str):
            body_bytes = data.encode('utf-8')
        req = urllib.request.Request(self.base + path, data=body_bytes, headers=hdrs, method=method)
        try:
            resp = self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as err:
            resp = err
        with resp:
            raw = resp.read()
            decoded = raw.decode('utf-8', errors='replace')
            if DIAGNOSTICS.search(decoded):
                raise AssertionError('PHP diagnostic in response: ' + decoded[:600])
            return resp.code, resp.headers, raw

    def csrf_from(self, path: str) -> str:
        status, _, body = self.request(path)
        assert status == 200, (path, status)
        m = re.search(rb"""name=["']csrf["'] value=["']([^"']+)["']""", body)
        assert m, f'CSRF token not found on {path}'
        return m.group(1).decode('utf-8')

    def post_form(self, path: str, fields: dict, csrf_page: str = '/admin'):
        token = self.csrf_from(csrf_page)
        return self.request(path, {'csrf': token, **fields}, method='POST')


def pkce_pair():
    verifier = base64.urlsafe_b64encode(uuid.uuid4().bytes + uuid.uuid4().bytes + uuid.uuid4().bytes).decode('ascii').rstrip('=')
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).decode('ascii').rstrip('=')
    return verifier, challenge


def basic_auth_header(client_id: str, client_secret: str) -> str:
    raw = urllib.parse.quote(client_id, safe='') + ':' + urllib.parse.quote(client_secret, safe='')
    return 'Basic ' + base64.b64encode(raw.encode('utf-8')).decode('ascii')


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


class McpIntegrationTests(unittest.TestCase):
    base = ''
    container = None
    database_path = None
    uploads_dir = None
    php_executable = None

    def sql_query(self, sql: str, params=None):
        params = params or []
        if self.container:
            script = (
                '$p = new PDO("sqlite:/var/www/html/storage/app.db");'
                '$p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);'
                '$s = $p->prepare($argv[1]);'
                '$s->execute(json_decode($argv[2], true));'
                'echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));'
            )
            out = subprocess.check_output(
                ['docker', 'exec', self.container, 'php', '-r', script, sql, json.dumps(params)],
                text=True,
            )
            return json.loads(out)
        with closing(sqlite3.connect(self.database_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            return [dict(r) for r in conn.execute(sql, params)]

    def sql_exec(self, sql: str, params=None):
        params = params or []
        if self.container:
            script = (
                '$p = new PDO("sqlite:/var/www/html/storage/app.db");'
                '$p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);'
                '$s = $p->prepare($argv[1]);'
                '$s->execute(json_decode($argv[2], true));'
            )
            subprocess.check_call(
                ['docker', 'exec', self.container, 'php', '-r', script, sql, json.dumps(params)]
            )
            return
        with closing(sqlite3.connect(self.database_path)) as conn, conn:
            conn.execute(sql, params)
            conn.commit()

    def write_upload_file(self, rel_path: str, content: bytes):
        if self.container:
            b64 = base64.b64encode(content).decode('ascii')
            script = (
                '$p = "/var/www/html/uploads/" . ltrim($argv[1], "/");'
                '@mkdir(dirname($p), 0775, true);'
                'file_put_contents($p, base64_decode($argv[2]));'
            )
            subprocess.check_call(['docker', 'exec', self.container, 'php', '-r', script, rel_path, b64])
            return
        target = Path(self.uploads_dir) / rel_path.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    def login_admin(self) -> HttpClient:
        c = HttpClient(self.base)
        status, hdrs, _ = c.post_form('/login', {'username': 'admin', 'password': 'Test-PHP83!pass'}, csrf_page='/login')
        self.assertEqual(status, 302)
        self.assertEqual(hdrs.get('Location'), '/dashboard')
        return c

    def create_oauth_client(self, admin: HttpClient, name: str = 'Gemini', redirect_uris=None):
        status, hdrs, _ = admin.post_form('/admin/mcp/client-create', {'name': name})
        self.assertEqual(status, 302)
        status, _, body = admin.request('/admin')
        self.assertEqual(status, 200)
        text = body.decode('utf-8')
        cid = re.search(r'\bsn_cid_[a-f0-9]{64}\b', text)
        csec = re.search(r'\bsn_cs_[A-Za-z0-9_-]{40,}\b', text)
        self.assertIsNotNone(cid, 'client_id not shown')
        self.assertIsNotNone(csec, 'client_secret not shown')
        client_id = cid.group(0)
        client_secret = csec.group(0)

        # Secret must only be displayed once.
        status2, _, body2 = admin.request('/admin')
        self.assertEqual(status2, 200)
        self.assertNotIn(client_secret, body2.decode('utf-8'))

        if redirect_uris is not None:
            status3, _, _ = admin.post_form(
                '/admin/mcp/client-update',
                {
                    'client_id': client_id,
                    'redirect_uris': '\n'.join(redirect_uris),
                    'require_pkce': '1',
                },
            )
            self.assertEqual(status3, 302)
        return client_id, client_secret

    def authorize_and_get_tokens(self, admin: HttpClient, client_id: str, client_secret: str, redirect_uri: str, use_basic: bool = True):
        verifier, challenge = pkce_pair()
        state = 'st_' + uuid.uuid4().hex[:10]
        qs = urllib.parse.urlencode({
            'response_type': 'code',
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'scope': 'notes:read',
            'state': state,
            'code_challenge': challenge,
            'code_challenge_method': 'S256',
            'resource': self.base + '/mcp',
        })
        status, hdrs, body = admin.request('/oauth/authorize?' + qs)
        self.assertEqual(status, 200)
        self.assertEqual(hdrs.get('X-Frame-Options'), 'DENY')
        self.assertIn("frame-ancestors 'none'", hdrs.get('Content-Security-Policy', ''))
        csrf = re.search(rb"""name=["']csrf["'] value=["']([^"']+)["']""", body).group(1).decode('utf-8')

        status, hdrs, _ = admin.request(
            '/oauth/authorize',
            {
                'csrf': csrf,
                'client_id': client_id,
                'redirect_uri': redirect_uri,
                'response_type': 'code',
                'scope': 'notes:read',
                'state': state,
                'code_challenge': challenge,
                'code_challenge_method': 'S256',
                'resource': self.base + '/mcp',
                'decision': 'allow',
            },
            method='POST',
        )
        self.assertEqual(status, 302)
        loc = hdrs.get('Location', '')
        self.assertTrue(loc.startswith(redirect_uri + '?'), loc)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(loc).query)
        self.assertEqual(q['state'], [state])
        self.assertEqual(q['iss'], [self.base])
        code = q['code'][0]
        self.assertTrue(code.startswith('sn_ac_'))

        stateless = HttpClient(self.base, use_cookies=False)
        form = {
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': redirect_uri,
            'code_verifier': verifier,
            'resource': self.base + '/mcp',
        }
        req_headers = {}
        if use_basic:
            req_headers['Authorization'] = basic_auth_header(client_id, client_secret)
        else:
            form['client_id'] = client_id
            form['client_secret'] = client_secret
        status, hdrs, raw = stateless.request('/oauth/token', form, headers=req_headers, method='POST')
        self.assertEqual(status, 200, raw.decode('utf-8', errors='replace'))
        self.assertIsNone(hdrs.get('Set-Cookie'), 'Stateless /oauth/token must not emit Set-Cookie')
        tok = json.loads(raw.decode('utf-8'))
        self.assertTrue(tok['access_token'].startswith('sn_at_'))
        self.assertTrue(tok['refresh_token'].startswith('sn_rt_'))
        return tok, code, verifier

    def mcp_call(self, access_token: str, payload, extra_headers=None):
        stateless = HttpClient(self.base, use_cookies=False)
        headers = {
            'Authorization': 'Bearer ' + access_token,
            'Content-Type': 'application/json',
        }
        if extra_headers:
            headers.update(extra_headers)
        raw_body = payload if isinstance(payload, (str, bytes)) else json.dumps(payload)
        return stateless.request('/mcp', raw_body, headers=headers, method='POST')

    def test_01_disabled_by_default_and_discovery(self):
        stateless = HttpClient(self.base, use_cookies=False)
        for path in [
            '/.well-known/oauth-protected-resource',
            '/.well-known/oauth-protected-resource/mcp',
            '/.well-known/oauth-authorization-server',
            '/.well-known/openid-configuration',
            '/oauth/authorize',
        ]:
            status, _, _ = stateless.request(path)
            self.assertEqual(status, 404, path)
        for path in ['/mcp', '/oauth/token', '/oauth/revoke']:
            status, _, _ = stateless.request(path, '{}', method='POST')
            self.assertEqual(status, 404, path)

        admin = self.login_admin()
        status, _, _ = admin.post_form('/admin/mcp/settings', {'mcp_enabled': '1'})
        self.assertEqual(status, 302)

        # Discovery endpoints now return 200 and NO Set-Cookie
        for path in ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']:
            status, hdrs, raw = stateless.request(path)
            self.assertEqual(status, 200, path)
            self.assertIsNone(hdrs.get('Set-Cookie'))
            data = json.loads(raw.decode('utf-8'))
            self.assertEqual(data['resource'], self.base + '/mcp')
            self.assertEqual(data['authorization_servers'], [self.base])

        for path in ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']:
            status, hdrs, raw = stateless.request(path)
            self.assertEqual(status, 200, path)
            self.assertIsNone(hdrs.get('Set-Cookie'))
            data = json.loads(raw.decode('utf-8'))
            self.assertEqual(data['authorization_endpoint'], self.base + '/oauth/authorize')
            self.assertEqual(data['token_endpoint'], self.base + '/oauth/token')
            self.assertEqual(data['code_challenge_methods_supported'], ['S256'])

        # Unauthenticated /mcp returns 401 + WWW-Authenticate and NO Set-Cookie
        status, hdrs, _ = stateless.request('/mcp', '{"jsonrpc":"2.0","id":1,"method":"ping"}', method='POST')
        self.assertEqual(status, 401)
        self.assertIsNone(hdrs.get('Set-Cookie'))
        www_auth = hdrs.get('WWW-Authenticate', '')
        self.assertIn('resource_metadata="' + self.base + '/.well-known/oauth-protected-resource/mcp"', www_auth)

    def test_02_oauth_flow_pkce_replay_grace_and_learning_mode(self):
        admin = self.login_admin()
        admin.post_form('/admin/mcp/settings', {'mcp_enabled': '1'})
        redirect_uri = 'https://oauth-redirect.googleusercontent.com/callback'
        cid, csec = self.create_oauth_client(admin, 'Gemini', redirect_uris=[])

        # Learning mode OFF: unregistered redirect URI is rejected and NOT recorded
        _, challenge = pkce_pair()
        qs = urllib.parse.urlencode({
            'response_type': 'code',
            'client_id': cid,
            'redirect_uri': redirect_uri,
            'code_challenge': challenge,
            'code_challenge_method': 'S256',
        })
        status, _, _ = admin.request('/oauth/authorize?' + qs)
        self.assertEqual(status, 400)
        self.assertEqual(len(self.sql_query('SELECT * FROM oauth_redirect_attempts')), 0)

        # Learning mode ON: captures attempts, caps at 20, allows one-click approval
        admin.post_form('/admin/mcp/settings', {'mcp_enabled': '1', 'mcp_learning_mode': '1'})
        for i in range(25):
            probe_uri = f'https://probe-{i}.example.com/cb'
            probe_qs = urllib.parse.urlencode({
                'response_type': 'code',
                'client_id': cid,
                'redirect_uri': probe_uri,
                'code_challenge': challenge,
                'code_challenge_method': 'S256',
            })
            st, _, _ = admin.request('/oauth/authorize?' + probe_qs)
            self.assertEqual(st, 400)
        self.assertLessEqual(len(self.sql_query('SELECT * FROM oauth_redirect_attempts')), 20)

        st, _, _ = admin.request('/oauth/authorize?' + qs)
        self.assertEqual(st, 400)
        attempts = self.sql_query('SELECT id FROM oauth_redirect_attempts WHERE redirect_uri = ?', [redirect_uri])
        self.assertEqual(len(attempts), 1)
        st, _, _ = admin.post_form('/admin/mcp/redirect-allow', {'attempt_id': str(attempts[0]['id'])})
        self.assertEqual(st, 302)
        admin.post_form('/admin/mcp/settings', {'mcp_enabled': '1'})

        # Unauthenticated /oauth/authorize -> /login -> password login -> returns to /oauth/authorize?...
        anon = HttpClient(self.base)
        st, hdrs, _ = anon.request('/oauth/authorize?' + qs)
        self.assertEqual(st, 302)
        self.assertEqual(hdrs.get('Location'), '/login')
        st, hdrs, _ = anon.post_form('/login', {'username': 'admin', 'password': 'Test-PHP83!pass'}, csrf_page='/login')
        self.assertEqual(st, 302)
        self.assertEqual(hdrs.get('Location'), '/oauth/authorize?' + qs)

        # Unencoded https:// in query string must still return safely to /oauth/authorize?...
        anon_raw = HttpClient(self.base)
        raw_qs = (
            f'response_type=code&client_id={cid}&redirect_uri={redirect_uri}'
            f'&code_challenge={challenge}&code_challenge_method=S256'
        )
        st, hdrs, _ = anon_raw.request('/oauth/authorize?' + raw_qs)
        self.assertEqual(st, 302)
        self.assertEqual(hdrs.get('Location'), '/login')
        st, hdrs, _ = anon_raw.post_form('/login', {'username': 'admin', 'password': 'Test-PHP83!pass'}, csrf_page='/login')
        self.assertEqual(st, 302)
        self.assertEqual(hdrs.get('Location'), '/oauth/authorize?' + raw_qs)

        # Non-authorize paths and open-redirect candidates must never be honored as oauth return_to
        anon_other = HttpClient(self.base)
        st, hdrs, _ = anon_other.request('/admin')
        self.assertEqual(st, 302)
        self.assertEqual(hdrs.get('Location'), '/login')
        st, hdrs, _ = anon_other.post_form('/login', {'username': 'admin', 'password': 'Test-PHP83!pass'}, csrf_page='/login')
        self.assertEqual(st, 302)
        self.assertEqual(hdrs.get('Location'), '/dashboard')

        index_path = '/var/www/html/index.php' if self.container else str((Path(self.database_path).parent.parent / 'index.php').resolve())
        check_script = (
            "define('SIYUAN_CLI_BOOTSTRAP_ONLY', true);"
            "$_SERVER['SCRIPT_NAME'] = '/index.php';"
            "$_SERVER['HTTP_HOST'] = 'localhost';"
            f"require {json.dumps(index_path)};"
            "$valid = '/oauth/authorize?client_id=c&redirect_uri=https://oauth-redirect.googleusercontent.com/callback';"
            "if (!mcp_is_safe_oauth_return_to($valid)) exit(1);"
            "foreach (['//evil.example/oauth/authorize?a=1', 'https://evil.example/oauth/authorize?a=1', '/admin?a=1', '/oauth/authorize', \"/oauth/authorize?a=1\\nLocation: https://evil.example\", '/oauth/authorize?a=1\\\\b'] as $bad) {"
            "  if (mcp_is_safe_oauth_return_to($bad)) exit(2);"
            "}"
        )
        if self.container:
            subprocess.check_call(['docker', 'exec', self.container, 'php', '-r', check_script])
        else:
            subprocess.check_call([self.php_executable, '-r', check_script])

        # Reject PKCE plain
        plain_qs = urllib.parse.urlencode({
            'response_type': 'code',
            'client_id': cid,
            'redirect_uri': redirect_uri,
            'code_challenge': 'a' * 43,
            'code_challenge_method': 'plain',
            'state': 's1',
        })
        st, hdrs, _ = admin.request('/oauth/authorize?' + plain_qs)
        self.assertEqual(st, 302)
        self.assertIn('error=invalid_request', hdrs.get('Location', ''))

        # Deny flow
        st, _, body = admin.request('/oauth/authorize?' + qs)
        self.assertEqual(st, 200)
        csrf = re.search(rb"""name=["']csrf["'] value=["']([^"']+)["']""", body).group(1).decode('utf-8')
        # Bad CSRF rejected
        st_bad, _, _ = admin.request('/oauth/authorize', {'csrf': 'bad', 'client_id': cid, 'redirect_uri': redirect_uri, 'response_type': 'code', 'code_challenge': challenge, 'code_challenge_method': 'S256', 'decision': 'allow'}, method='POST')
        self.assertEqual(st_bad, 400)
        st_deny, hdrs_deny, _ = admin.request('/oauth/authorize', {'csrf': csrf, 'client_id': cid, 'redirect_uri': redirect_uri, 'response_type': 'code', 'code_challenge': challenge, 'code_challenge_method': 'S256', 'decision': 'deny'}, method='POST')
        self.assertEqual(st_deny, 302)
        self.assertIn('error=access_denied', hdrs_deny.get('Location', ''))

        # Full allow + Basic auth token exchange
        tok, used_code, verifier = self.authorize_and_get_tokens(admin, cid, csec, redirect_uri, use_basic=True)
        # Replay of used code revokes entire token family
        stateless = HttpClient(self.base, use_cookies=False)
        st, _, raw = stateless.request(
            '/oauth/token',
            {'grant_type': 'authorization_code', 'code': used_code, 'redirect_uri': redirect_uri, 'code_verifier': verifier},
            headers={'Authorization': basic_auth_header(cid, csec)},
            method='POST',
        )
        self.assertEqual(st, 400)
        self.assertEqual(json.loads(raw)['error'], 'invalid_grant')
        st, _, _ = self.mcp_call(tok['access_token'], {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'})
        self.assertEqual(st, 401)

        # Full allow + POST body client auth + refresh token grace window & replay revocation
        tok2, _, _ = self.authorize_and_get_tokens(admin, cid, csec, redirect_uri, use_basic=False)
        old_refresh = tok2['refresh_token']
        # Wrong client secret -> 401
        st, _, _ = stateless.request(
            '/oauth/token',
            {'grant_type': 'refresh_token', 'refresh_token': old_refresh, 'client_id': cid, 'client_secret': 'wrong'},
            method='POST',
        )
        self.assertEqual(st, 401)

        # First refresh succeeds
        st, _, raw = stateless.request(
            '/oauth/token',
            {'grant_type': 'refresh_token', 'refresh_token': old_refresh},
            headers={'Authorization': basic_auth_header(cid, csec)},
            method='POST',
        )
        self.assertEqual(st, 200)
        tok3 = json.loads(raw)

        # Second refresh with old token within 30s grace window -> 400 invalid_grant, new access token STILL WORKS
        st, _, raw = stateless.request(
            '/oauth/token',
            {'grant_type': 'refresh_token', 'refresh_token': old_refresh},
            headers={'Authorization': basic_auth_header(cid, csec)},
            method='POST',
        )
        self.assertEqual(st, 400)
        self.assertEqual(json.loads(raw)['error'], 'invalid_grant')
        st, _, _ = self.mcp_call(tok3['access_token'], {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'})
        self.assertEqual(st, 200)

        # Simulate >30s elapsed -> reuse of old refresh token revokes entire family
        old_hash = hashlib.sha256(old_refresh.encode('utf-8')).hexdigest()
        self.sql_exec('UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ?', [int(time.time()) - 45, old_hash])
        st, _, _ = stateless.request(
            '/oauth/token',
            {'grant_type': 'refresh_token', 'refresh_token': old_refresh},
            headers={'Authorization': basic_auth_header(cid, csec)},
            method='POST',
        )
        self.assertEqual(st, 400)
        st, _, _ = self.mcp_call(tok3['access_token'], {'jsonrpc': '2.0', 'id': 2, 'method': 'ping'})
        self.assertEqual(st, 401)

        # Revocation endpoint
        tok4, _, _ = self.authorize_and_get_tokens(admin, cid, csec, redirect_uri, use_basic=True)
        st, _, _ = stateless.request(
            '/oauth/revoke',
            {'token': tok4['refresh_token']},
            headers={'Authorization': basic_auth_header(cid, csec)},
            method='POST',
        )
        self.assertEqual(st, 200)
        st, _, _ = self.mcp_call(tok4['access_token'], {'jsonrpc': '2.0', 'id': 3, 'method': 'ping'})
        self.assertEqual(st, 401)

    def test_03_mcp_protocol_content_permissions_and_navigation(self):
        admin = self.login_admin()
        admin.post_form('/admin/mcp/settings', {'mcp_enabled': '1', 'mcp_debug_logs_enabled': '1'})
        redirect_uri = 'https://oauth-redirect.googleusercontent.com/callback'
        cid, csec = self.create_oauth_client(admin, 'Gemini', redirect_uris=[redirect_uri])
        tok, _, _ = self.authorize_and_get_tokens(admin, cid, csec, redirect_uri)
        access = tok['access_token']

        # Protocol checks: GET/DELETE 405, Origin 403, invalid JSON -32700, unknown method -32601
        stateless = HttpClient(self.base, use_cookies=False)
        for m in ['GET', 'DELETE']:
            st, hdrs, _ = stateless.request('/mcp', headers={'Authorization': 'Bearer ' + access}, method=m)
            self.assertEqual(st, 405)
            self.assertEqual(hdrs.get('Allow'), 'POST')

        st, hdrs, _ = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, {'Origin': 'https://evil.example'})
        self.assertEqual(st, 403)
        self.assertIsNone(hdrs.get('Access-Control-Allow-Origin'))

        st, _, raw = self.mcp_call(access, '{invalid json')
        self.assertEqual(st, 400)
        self.assertEqual(json.loads(raw)['error']['code'], -32700)

        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 1, 'method': 'unknown/method'})
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)['error']['code'], -32601)

        # Initialize version negotiation
        for ver, expected in [
            ('2025-11-25', '2025-11-25'),
            ('2025-06-18', '2025-06-18'),
            ('2025-03-26', '2025-03-26'),
            ('2099-01-01', '2025-11-25'),
        ]:
            st, hdrs, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': ver}})
            self.assertEqual(st, 200)
            self.assertIsNone(hdrs.get('Set-Cookie'))
            res = json.loads(raw)['result']
            self.assertEqual(res['protocolVersion'], expected)
            self.assertIn('list_shares', res['instructions'])
            self.assertEqual(res['capabilities']['tools']['listChanged'], False)

        # Notification -> 202 empty body
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        self.assertEqual(st, 202)
        self.assertEqual(raw, b'')

        # Ping -> {}
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 2, 'method': 'ping'})
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)['result'], {})

        # Batch limit > 20 -> -32600
        big_batch = [{'jsonrpc': '2.0', 'id': i, 'method': 'ping'} for i in range(21)]
        st, _, raw = self.mcp_call(access, big_batch)
        self.assertEqual(st, 400)
        self.assertEqual(json.loads(raw)['error']['code'], -32600)

        # tools/list -> 5 tools with readOnlyHint=True
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/list'})
        self.assertEqual(st, 200)
        tools = json.loads(raw)['result']['tools']
        self.assertEqual(len(tools), 5)
        for t in tools:
            self.assertTrue(t['annotations']['readOnlyHint'])
            self.assertIn('outputSchema', t)

        # Seed realistic multi-semester data + non-public shares
        now_str = '2026-11-20 12:00:00'
        self.sql_exec("UPDATE settings SET value = ? WHERE key = 'reader_home_url'", [self.base + '/s/homeindex'])
        self.sql_exec(
            "INSERT INTO shares (user_id, type, slug, title, doc_id, created_at, updated_at) VALUES (1, 'doc', 'homeindex', 'Choose the Semester', 'home-root', ?, ?)",
            [now_str, now_str],
        )
        home_sid = self.sql_query("SELECT id FROM shares WHERE slug = 'homeindex'")[0]['id']
        self.sql_exec(
            "INSERT INTO share_docs (share_id, doc_id, title, hpath, markdown, sort_order, created_at, updated_at) VALUES (?, 'home-root', 'Choose the Semester', '/Choose the Semester', 'Welcome to notes.', 0, ?, ?)",
            [home_sid, now_str, now_str],
        )

        # 5th semester notebook with Differential Geometry -> Lecture -> Tangent Space
        self.sql_exec(
            "INSERT INTO shares (user_id, type, slug, title, created_at, updated_at) VALUES (1, 'notebook', 'sem5note', 'GTIIT 5th Semester', ?, ?)",
            [now_str, now_str],
        )
        sem5_sid = self.sql_query("SELECT id FROM shares WHERE slug = 'sem5note'")[0]['id']

        sample_md = (
            "---\ntitle: 11.6 Tangent Space\n---\n"
            "# 11.6 Tangent Space\n\n"
            "Intro paragraph with `{: keep_inline_code=\"1\"}` and inline IAL {: id=\"20261106-aaa\" updated=\"20261106\"}\n"
            "{: id=\"standalone-ial\"}\n\n"
            "![diagram](assets/笔记 图.png)\n\n"
            "## Definition\n\n"
            "Let $M$ be a smooth manifold. The tangent space $T_p M$ satisfies:\n\n"
            "$$\nT_p M = \\{ v : C^\\infty(M) \\to \\mathbb{R} \\}\n{: keep_math=\"1\"}\n$$\n\n"
            "```python\n"
            "# not a heading\n"
            "x = '{: keep_code=\"1\"}'\n"
            "path = 'assets/笔记 图.png'\n"
            "```\n\n"
            "## Properties\n\n"
            + ("Paragraph about differential geometry tangent vectors and derivations.\n\n" * 40)
        )
        self.write_upload_file(f's_{sem5_sid}/diagram.png', b'\x89PNG\r\n\x1a\nfake')
        self.sql_exec(
            "INSERT INTO share_assets (share_id, doc_id, asset_path, file_path, size_bytes, created_at) VALUES (?, 'doc-tangent', 'assets/笔记 图.png', ?, 12, ?)",
            [sem5_sid, f's_{sem5_sid}/diagram.png', now_str],
        )

        sem5_docs = [
            ('course-dg', 'Differential Geometry', '/Differential Geometry', '', 0, ''),
            ('dg-lec', 'Lecture', '/Differential Geometry/Lecture', 'course-dg', 1, ''),
            ('dg-tut', 'Tutorial', '/Differential Geometry/Tutorial', 'course-dg', 2, ''),
            ('dg-hw', 'Homework', '/Differential Geometry/Homework', 'course-dg', 3, ''),
            ('doc-tangent', '11.6 Tangent Space', '/Differential Geometry/Lecture/11.6 Tangent Space', 'dg-lec', 4, sample_md),
            ('doc-body-only', 'Other Note', '/Other/Other Note', '', 5, 'Mentions tangent space only in the body.'),
            ('doc-hpath-hit', 'Exercises', '/Differential Geometry/Tangent Space/Exercises', 'dg-tut', 6, 'Practice problems.'),
        ]
        for doc_id, title, hpath, parent_id, order, md in sem5_docs:
            self.sql_exec(
                "INSERT INTO share_docs (share_id, doc_id, title, hpath, parent_id, sort_index, markdown, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [sem5_sid, doc_id, title, hpath, parent_id, order, md, order, now_str, now_str],
            )

        # Non-public shares: password, expired, deleted
        self.sql_exec(
            "INSERT INTO shares (user_id, type, slug, title, password_hash, created_at, updated_at) VALUES (1, 'doc', 'secretsh', 'Secret Share', '$2y$10$abcdefghijklmnopqrstuv', ?, ?)",
            [now_str, now_str],
        )
        secret_sid = self.sql_query("SELECT id FROM shares WHERE slug = 'secretsh'")[0]['id']
        self.sql_exec(
            "INSERT INTO share_docs (share_id, doc_id, title, hpath, markdown, sort_order, created_at, updated_at) VALUES (?, 'sec-doc', 'Secret Tangent Space', '/Secret', 'Top secret tangent space.', 0, ?, ?)",
            [secret_sid, now_str, now_str],
        )
        self.sql_exec(
            "INSERT INTO shares (user_id, type, slug, title, expires_at, created_at, updated_at) VALUES (1, 'doc', 'expiredsh', 'Expired Share', ?, ?, ?)",
            [int(time.time()) - 3600, now_str, now_str],
        )
        self.sql_exec(
            "INSERT INTO shares (user_id, type, slug, title, deleted_at, created_at, updated_at) VALUES (1, 'doc', 'deletedsh', 'Deleted Share', ?, ?, ?)",
            [now_str, now_str, now_str],
        )

        # list_shares: only public shares, home marked, top-level course present
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 10, 'method': 'tools/call', 'params': {'name': 'list_shares', 'arguments': {}}})
        self.assertEqual(st, 200)
        ls = json.loads(raw)['result']['structuredContent']
        slugs = [s['slug'] for s in ls['shares']]
        self.assertIn('sem5note', slugs)
        self.assertIn('homeindex', slugs)
        for hidden in ['secretsh', 'expiredsh', 'deletedsh']:
            self.assertNotIn(hidden, slugs)
        home_entry = next(s for s in ls['shares'] if s['slug'] == 'homeindex')
        self.assertTrue(home_entry['is_home'])
        sem5_entry = next(s for s in ls['shares'] if s['slug'] == 'sem5note')
        dg_node = next(n for n in sem5_entry['top_level_docs'] if n['doc_id'] == 'course-dg')
        self.assertEqual(dg_node['child_count'], 3)
        self.assertEqual(dg_node['char_count'], 0)

        # Hierarchical drill-down: Differential Geometry -> Lecture -> 11.6 Tangent Space
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 11, 'method': 'tools/call', 'params': {'name': 'get_share_tree', 'arguments': {'share': 'sem5note', 'parent_doc_id': 'course-dg', 'max_depth': 1}}})
        tree1 = json.loads(raw)['result']['structuredContent']
        self.assertEqual([n['title'] for n in tree1['nodes']], ['Lecture', 'Tutorial', 'Homework'])

        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 12, 'method': 'tools/call', 'params': {'name': 'get_share_tree', 'arguments': {'share': 'sem5note', 'parent_doc_id': 'dg-lec'}}})
        tree2 = json.loads(raw)['result']['structuredContent']
        self.assertEqual([n['doc_id'] for n in tree2['nodes']], ['doc-tangent'])

        # IDOR protection: secret share's doc_id via public share fails with isError=True
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 13, 'method': 'tools/call', 'params': {'name': 'read_document', 'arguments': {'share': 'sem5note', 'doc_id': 'sec-doc'}}})
        self.assertTrue(json.loads(raw)['result']['isError'])

        # read_document via full URL + cleaning + Chinese asset HTTP 200
        full_url = f'{self.base}/s/sem5note/doc-tangent#properties'
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 14, 'method': 'tools/call', 'params': {'name': 'read_document', 'arguments': {'share': full_url}}})
        rd = json.loads(raw)['result']['structuredContent']
        content = rd['content']
        self.assertNotIn('title: 11.6 Tangent Space', content)
        self.assertNotIn('20261106-aaa', content)
        self.assertNotIn('standalone-ial', content)
        self.assertIn('{: keep_math="1"}', content)
        self.assertIn('{: keep_code="1"}', content)
        self.assertIn('`{: keep_inline_code="1"}`', content)
        self.assertIn("path = 'assets/笔记 图.png'", content)
        expected_asset_url = self.base + '/s/sem5note/res/assets/%E7%AC%94%E8%AE%B0%20%E5%9B%BE.png'
        self.assertIn(expected_asset_url, content)
        st_asset, _, asset_bytes = stateless.request('/s/sem5note/res/assets/%E7%AC%94%E8%AE%B0%20%E5%9B%BE.png')
        self.assertEqual(st_asset, 200)
        self.assertTrue(asset_bytes.startswith(b'\x89PNG'))

        # Outline ignores # comment inside code fence & offsets align with read_document
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 15, 'method': 'tools/call', 'params': {'name': 'get_document_outline', 'arguments': {'share': 'sem5note', 'doc_id': 'doc-tangent'}}})
        outline = json.loads(raw)['result']['structuredContent']
        titles = [h['title'] for h in outline['headings']]
        self.assertEqual(titles, ['Definition', 'Properties'])
        prop_offset = outline['headings'][1]['offset']
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 16, 'method': 'tools/call', 'params': {'name': 'read_document', 'arguments': {'share': 'sem5note', 'doc_id': 'doc-tangent', 'offset': prop_offset}}})
        self.assertTrue(json.loads(raw)['result']['structuredContent']['content'].startswith('## Properties'))

        # Chunked reading reconstructs exact full document
        chunks = []
        offset = 0
        while True:
            st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 17, 'method': 'tools/call', 'params': {'name': 'read_document', 'arguments': {'share': 'sem5note', 'doc_id': 'doc-tangent', 'offset': offset, 'max_chars': 1000}}})
            part = json.loads(raw)['result']['structuredContent']
            chunks.append(part['content'])
            if part['next_offset'] is None:
                break
            offset = part['next_offset']
        self.assertEqual(''.join(chunks), content)

        # Search ranking: title > hpath > body, and subtree search
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 18, 'method': 'tools/call', 'params': {'name': 'search_notes', 'arguments': {'query': 'Tangent Space'}}})
        sr = json.loads(raw)['result']['structuredContent']
        self.assertEqual([r['doc_id'] for r in sr['results']], ['doc-tangent', 'doc-hpath-hit', 'doc-body-only'])

        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 19, 'method': 'tools/call', 'params': {'name': 'search_notes', 'arguments': {'query': 'Tangent Space', 'share': 'sem5note', 'parent_doc_id': 'dg-lec'}}})
        sr_sub = json.loads(raw)['result']['structuredContent']
        self.assertEqual([r['doc_id'] for r in sr_sub['results']], ['doc-tangent'])

        # Real-time permission revocation: adding password immediately hides share
        self.sql_exec("UPDATE shares SET password_hash = '$2y$10$nowprotected' WHERE slug = 'sem5note'")
        st, _, raw = self.mcp_call(access, {'jsonrpc': '2.0', 'id': 20, 'method': 'tools/call', 'params': {'name': 'read_document', 'arguments': {'share': 'sem5note', 'doc_id': 'doc-tangent'}}})
        self.assertTrue(json.loads(raw)['result']['isError'])

        # Debug logs and usage statistics exist, track tokens/errors, and never leak tokens/secrets
        st, _, admin_html = admin.request('/admin')
        self.assertEqual(st, 200)
        admin_text = admin_html.decode('utf-8')
        self.assertIn('tools/call:read_document', admin_text)
        self.assertIn('id="mcp-usage-stats"', admin_text)
        self.assertIn('data-mcp-filter="warnings"', admin_text)
        self.assertIn('405 Method Not Allowed', admin_text)
        self.assertIn('mcp-status-bang', admin_text)
        self.assertNotIn(access, admin_text)
        self.assertNotIn(csec, admin_text)

        read_stats = self.sql_query("SELECT * FROM mcp_usage_stats WHERE metric_key = 'tools/call:read_document'")
        self.assertEqual(len(read_stats), 1)
        self.assertGreaterEqual(int(read_stats[0]['call_count']), 5)
        self.assertGreaterEqual(int(read_stats[0]['error_count']), 2)
        self.assertGreater(int(read_stats[0]['total_tokens']), 100)
        self.assertGreater(int(read_stats[0]['total_chars']), 300)

        tok_logs = self.sql_query("SELECT * FROM mcp_debug_logs WHERE rpc_method = 'tools/call:read_document' AND est_tokens > 0")
        self.assertGreater(len(tok_logs), 0)

        st, _, _ = admin.post_form('/admin/mcp/logs-clear', {})
        self.assertEqual(st, 302)
        self.assertEqual(len(self.sql_query('SELECT * FROM mcp_debug_logs')), 0)
        # Clearing debug logs must not wipe cumulative usage statistics
        self.assertGreater(len(self.sql_query('SELECT * FROM mcp_usage_stats')), 0)

        st, _, _ = admin.post_form('/admin/mcp/stats-reset', {})
        self.assertEqual(st, 302)
        self.assertEqual(len(self.sql_query('SELECT * FROM mcp_usage_stats')), 0)

    def test_04_internal_static_token_auth(self):
        admin = self.login_admin()
        status, _, _ = admin.post_form('/admin/mcp/settings', {'mcp_enabled': '1'})
        self.assertEqual(status, 302)

        stateless = HttpClient(self.base, use_cookies=False)

        # Wrong internal header must still fail with 401
        st_bad, _, _ = stateless.request(
            '/mcp',
            json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}),
            headers={
                'Content-Type': 'application/json',
                'X-MCP-Internal-Token': 'wrong-token',
            },
            method='POST',
        )
        self.assertEqual(st_bad, 401)

        # Lower-priority config.php token must fail with 401 while MCP_INTERNAL_TOKEN env var is set
        st_cfg, _, _ = stateless.request(
            '/mcp',
            json.dumps({'jsonrpc': '2.0', 'id': 11, 'method': 'tools/list'}),
            headers={
                'Content-Type': 'application/json',
                'X-MCP-Internal-Token': 'test-internal-gateway-token-64hex',
            },
            method='POST',
        )
        self.assertEqual(st_cfg, 401)

        # Valid internal header from Docker/env authenticates without OAuth Bearer token
        st_ok, _, raw_list = stateless.request(
            '/mcp',
            json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}),
            headers={
                'Content-Type': 'application/json',
                'X-MCP-Internal-Token': ENV_INTERNAL_TOKEN,
            },
            method='POST',
        )
        self.assertEqual(st_ok, 200)
        tools = json.loads(raw_list)['result']['tools']
        self.assertEqual(len(tools), 5)

        st_call, _, raw_call = stateless.request(
            '/mcp',
            json.dumps({
                'jsonrpc': '2.0',
                'id': 3,
                'method': 'tools/call',
                'params': {'name': 'list_shares', 'arguments': {}},
            }),
            headers={
                'Content-Type': 'application/json',
                'X-MCP-Internal-Token': ENV_INTERNAL_TOKEN,
            },
            method='POST',
        )
        self.assertEqual(st_call, 200)
        res = json.loads(raw_call)['result']
        self.assertFalse(res['isError'])
        self.assertIn('shares', res['structuredContent'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--php', help='PHP 8.3 CLI executable')
    mode.add_argument('--docker', help='Already built application image')
    args = parser.parse_args()

    process = container = None
    log_text = ''
    diagnostics = []
    result = None

    with tempfile.TemporaryDirectory(prefix='siyuan-mcp-test-') as directory:
        work = Path(directory)
        app = work / 'app'
        shutil.copytree(ROOT / 'php-site', app, ignore=shutil.ignore_patterns('config.php', 'storage', 'uploads'))
        (app / 'config.php').write_text(CONFIG, encoding='utf-8')
        (app / 'storage').mkdir()
        (app / 'uploads').mkdir()
        php_log = work / 'php.log'
        php_ini = work / 'regression.ini'
        php_ini.write_text('error_reporting=E_ALL\nlog_errors=On\ndisplay_errors=Off\n', encoding='utf-8')

        try:
            if args.php:
                php = str(Path(args.php).resolve())
                sessions = work / 'sessions'
                sessions.mkdir()
                php_args = [
                    php, '-d', 'error_reporting=32767', '-d', 'log_errors=1',
                    '-d', 'display_errors=0', '-d', 'error_log=' + str(php_log),
                    '-d', 'session.save_path=' + str(sessions),
                ]
                for p in app.rglob('*.php'):
                    command([*php_args, '-l', str(p)], stdout=subprocess.DEVNULL)
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                router = work / 'router.php'
                router.write_text(
                    "<?php\n$_SERVER['SCRIPT_NAME'] = '/index.php';\nrequire __DIR__ . '/app/index.php';\n",
                    encoding='utf-8',
                )
                output = (work / 'server.log').open('w', encoding='utf-8')
                process = subprocess.Popen(
                    [*php_args, '-S', f'127.0.0.1:{port}', '-t', str(app), str(router)],
                    stdout=output,
                    stderr=output,
                    env={**os.environ, 'MCP_INTERNAL_TOKEN': ENV_INTERNAL_TOKEN, 'MCP_INTERNAL_USER_ID': '1'},
                )
            else:
                name = 'siyuan-mcp-test-' + uuid.uuid4().hex[:10]
                container = name
                command(
                    [
                        'docker', 'create', '--name', name,
                        '-e', f'MCP_INTERNAL_TOKEN={ENV_INTERNAL_TOKEN}',
                        '-e', 'MCP_INTERNAL_USER_ID=1',
                        '--volume', '/var/www/html/storage',
                        '--volume', '/var/www/html/uploads',
                        '-p', '127.0.0.1::80',
                        args.docker,
                    ],
                    stdout=subprocess.DEVNULL,
                )
                for src, dst in [
                    (app / 'config.php', '/var/www/html/config.php'),
                    (php_ini, '/usr/local/etc/php/conf.d/zz-regression.ini'),
                ]:
                    command(['docker', 'cp', str(src), name + ':' + dst])
                command(['docker', 'start', name], stdout=subprocess.DEVNULL)
                port = subprocess.check_output(['docker', 'port', name, '80/tcp'], text=True).strip().rsplit(':', 1)[1]
                command(['docker', 'exec', name, 'sh', '-ec', 'find /var/www/html -name "*.php" -exec php -l {} \\; > /tmp/lint.log 2>&1; ! grep -E "Errors parsing|Parse error|Deprecated:|Warning:" /tmp/lint.log'])
                command(['docker', 'exec', name, 'nginx', '-t'])

            McpIntegrationTests.base = f'http://127.0.0.1:{port}'
            McpIntegrationTests.container = container
            McpIntegrationTests.database_path = str(app / 'storage/app.db')
            McpIntegrationTests.uploads_dir = str(app / 'uploads')
            McpIntegrationTests.php_executable = args.php

            deadline = time.monotonic() + 45
            while True:
                try:
                    if HttpClient(McpIntegrationTests.base).request('/login')[0] == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError('Application did not become ready')
                time.sleep(0.25)

            # Set known test password for admin in this disposable database
            helper = McpIntegrationTests('runTest')
            helper.sql_exec(
                "UPDATE users SET password_hash='$2y$10$nxAGHI1ZkpshiwzuMgwQDu7PYcOgGdhTK8FdVri6aUdfuYpHyQ5hS', must_change_password=0 WHERE username='admin'"
            )

            suite = unittest.defaultTestLoader.loadTestsFromTestCase(McpIntegrationTests)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
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
