# Hidden provenance font

`fonts/pdf-provenance.ttf` is a renamed, regular-weight subset of Noto Sans SC
from https://github.com/google/fonts/tree/main/ofl/notosanssc.

- Original: `NotoSansSC[wght].ttf`, downloaded 2026-10-26.
- Original SHA256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
- License: `pdf-provenance.OFL.txt` (SIL Open Font License 1.1).
- Subset family: Share PDF Hidden; PostScript name: SharePDFHidden-Regular.
- Generated with fontTools: instantiate weight 400, then subset to ASCII U+0020–U+007E
  and the characters in `原文网址：作者：塵版权说明：随意传播，禁止售卖`.

This font is fetched only when saving a PDF and embedded for its invisible text
layer. It does not change the reader, mathematics or rendered page typography.
Original URLs are normalized with the URL API and percent-encoded, so ASCII is
sufficient for their text. No tracking or export identifier is included.
