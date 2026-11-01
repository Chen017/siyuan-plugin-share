"""Require an existing release tag to resolve to the checked-out commit."""
import subprocess
import sys


def main(version, expected):
    result = subprocess.run(
        ['git', 'rev-parse', '--verify', '--quiet', f'refs/tags/{version}^{{commit}}'],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f'Cannot resolve existing tag {version} to a commit; fetch tags and retry.')
    actual = result.stdout.strip()
    if actual != expected:
        raise SystemExit(f'Tag {version} points to {actual}, but this run builds {expected}.')
    print(f'Tag {version} resolves to the checked-out commit {actual}.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: check-release-tag.py VERSION EXPECTED_COMMIT')
    main(*sys.argv[1:])
