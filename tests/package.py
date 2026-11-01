"""Verify server/plugin archive completeness using disposable output, without publishing."""
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
import zipfile
from urllib.parse import unquote, urlsplit

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='siyuan-package-') as directory:
    subprocess.run([sys.executable, str(root / 'scripts/package.py'), '--output', directory, '--version', 'test'], check=True)
    with zipfile.ZipFile(Path(directory) / 'package.zip') as archive:
        assert archive.testzip() is None
        names = set(archive.namelist())
        assert {'index.js', 'index.css', 'plugin.json', 'i18n/en_US.json', 'i18n/zh_CN.json', 'resources/controls.js', 'resources/controls.css', 'docs/MAINTENANCE.md', 'docs/GUEST_PDF_EXPORT.md', 'docs/UPLOAD_SAFETY.md'} <= names
        assert not any(name.startswith(('php-site/', 'tests/', '.git/', '.test-output/')) for name in archive.namelist())
        for name in (name for name in names if name.endswith('.md') and (name.startswith('docs/') or '/' not in name)):
            for target in re.findall(r'(?<!!)\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)', archive.read(name).decode('utf-8')):
                parsed = urlsplit(target)
                if not parsed.scheme and not parsed.netloc and parsed.path:
                    assert posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(parsed.path))) in names, (name, target)
    with zipfile.ZipFile(Path(directory) / 'php-site-test.zip') as archive:
        names = set(archive.namelist())
        assert archive.testzip() is None
        assert {'index.php', 'admin.php', 'config.example.php', 'pdf-export.php', 'pdf-visitor.php', 'assets/app.js', 'robots.txt', 'llms.txt'} <= names
        assert {'assets/vendor/RENDERER_DEPENDENCIES.md', 'assets/vendor/markdown-it.LICENSE.txt', 'assets/vendor/mermaid.LICENSE.txt'} <= names
        assert 'config.php' not in names
        assert 'assets/MiSans-Latin.woff2' in names
        assert not {'assets/MiSans-Regular.ttf', 'assets/MiSansVF.ttf'} & names
        assert not any(name.startswith('resources/') for name in names)
        assert all((info.external_attr >> 16) & 0o777 == 0o644 for info in archive.infolist()), 'Server files need readable permissions after extraction'
        assert not any(name.startswith(('storage/', 'uploads/', 'tests/', '.git/', '.test-output/')) for name in names)
        for name in sorted(names):
            if name.endswith('.php'):
                source = archive.read(name).decode('utf-8')
                for dependency in re.findall(r"(?:require|include)(?:_once)?\s+__DIR__\s*\.\s*['\"](/[^'\"]+)['\"]", source):
                    if dependency in ('/config.php', '/config.example.php'):
                        continue  # Config is optional; the shipped example is checked separately.
                    assert dependency.lstrip('/') in names, (name, dependency)
print('Packaging passed: plugin entry points and all PHP modules/assets included; local config and runtime data excluded.')
