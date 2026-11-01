"""Check local Markdown links in the maintained project documentation."""
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

root = Path(__file__).resolve().parents[1]
documents = [root / 'README.md', root / 'README_zh_CN.md', *sorted((root / 'docs').glob('*.md'))]
missing = []
for document in documents:
    for target in re.findall(r'(?<!!)\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)', document.read_text(encoding='utf-8')):
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        if not (document.parent / unquote(parsed.path)).is_file():
            missing.append(f'{document.relative_to(root)}: {target}')
if missing:
    raise SystemExit('Missing local documentation links:\n' + '\n'.join(missing))
print(f'Documentation links passed: {len(documents)} maintained Markdown files.')
