"""Build the Latin MiSans web font; Chinese deliberately uses system fallback.

Run with Python and fonttools[woff]. The original font and its name/license
records are retained under resources/fonts, outside the public server assets.
Regenerate the subset when updating MiSans-Regular.ttf.
"""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'resources/fonts/MiSans-Regular.ttf'
TARGET = ROOT / 'php-site/assets/MiSans-Latin.woff2'
RANGES = [(0x0000, 0x024F), (0x0300, 0x036F), (0x1E00, 0x1EFF),
          (0x2000, 0x206F), (0x20A0, 0x20CF)]

font = TTFont(SOURCE, recalcTimestamp=False)
original_cmap = font.getBestCmap()
original_metrics = dict(font['hmtx'].metrics)
points = {cp for cp in original_cmap if any(a <= cp <= b for a, b in RANGES)}
options = subset.Options()
options.flavor = 'woff2'
options.glyph_names = True
options.name_IDs = ['*']
options.name_languages = ['*']
options.layout_features = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=points)
subsetter.subset(font)
font.flavor = 'woff2'
font.save(TARGET)

result = TTFont(TARGET)
cmap = result.getBestCmap()
assert set(cmap) == points
assert all(cp in cmap for cp in range(0x20, 0x7F))
assert not any(0x3400 <= cp <= 0x9FFF for cp in cmap)
assert all(result['hmtx'].metrics[name] == original_metrics[original_cmap[cp]]
           for cp, name in cmap.items())
print(f'{SOURCE.stat().st_size:,} -> {TARGET.stat().st_size:,} bytes; '
      f'{len(cmap)} Latin/punctuation codepoints; original advance widths preserved')
