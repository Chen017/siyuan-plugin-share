"""Build the no-build plugin and PHP server ZIPs without runtime data or local config."""
import argparse
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ITEMS = (
    'i18n', 'LICENSE', 'README.md', 'README_zh_CN.md',
    'icon.png', 'index.css', 'index.js', 'plugin.json',
)
SERVER_ITEMS = ('assets', 'vendor', '.well-known', 'robots.txt', 'llms.txt')


def write_archive(source, items, destination):
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for item in items:
            path = source / item
            if not path.exists():
                raise FileNotFoundError(path)
            for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
                if file.is_file():
                    info = zipfile.ZipInfo.from_file(file, file.relative_to(source).as_posix())
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


def build(output, version):
    # Version is also a filename component; never accept a path or shell expression.
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', version):
        raise ValueError('Version must be a plain filename component')
    output.mkdir(parents=True, exist_ok=True)
    write_archive(ROOT, PLUGIN_ITEMS, output / 'package.zip')
    # Ship the same canonical progressive controls to the plugin and the website.
    with zipfile.ZipFile(output / 'package.zip', 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ('controls.js', 'controls.css'):
            archive.writestr('resources/' + name, (ROOT / 'php-site/assets' / name).read_bytes())
    source = ROOT / 'php-site'
    modules = sorted(p.name for p in source.glob('*.php') if p.name != 'config.php')
    write_archive(source, [*SERVER_ITEMS, *modules], output / f'php-site-{version}.zip')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    build(args.output, args.version)
