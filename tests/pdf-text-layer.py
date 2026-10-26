"""Verify selection using Chrome/Edge's PDF engine, not PDF byte patterns."""
import json
from pathlib import Path
import sys
import pypdfium2 as pdfium

output = Path(sys.argv[1])
baseline = pdfium.PdfDocument(output / 'baseline.pdf')
pdf = pdfium.PdfDocument(output / 'selectable.pdf')
assert len(pdf) == 1
page = pdf[0]
textpage = page.get_textpage()
text = textpage.get_text_range().replace('\r', '').replace('\n', '')
for sample in json.loads((output / 'expected.json').read_text(encoding='utf8')):
    assert sample in text, repr(sample)
match = textpage.search('Selectable').get_next()
assert match is not None
left, bottom, right, top = textpage.get_charbox(match[0])
unit = 72 / 25.4
assert abs(left - 14 * unit) < 0.02
assert abs((right - left) - 12 * 182 / 687 * unit) < 0.02
assert abs((top - bottom) - 20 * 182 / 687 * unit) < 0.02
assert bytes(page.render().buffer) == bytes(baseline[0].render().buffer)
print('PDFium passed: selectable Unicode, Greek, emoji, combining characters, multiple font maps, search, exact selection boxes, and unchanged visible pixels.')
