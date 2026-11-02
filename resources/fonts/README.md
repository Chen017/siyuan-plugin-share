# MiSans fonts

The reader and exported PDFs use Xiaomi's MiSans font service Latin WOFF2
subsets for weights 400, 500 and 600, with system-font fallback for Chinese.
The files under `php-site/assets/MiSans-official-*` were downloaded from the
official `font.sec.miui.com/font/css?family=MiSans:400,500,600,650:Latin&display=swap`
font service on 2026-11-02, using its declared unicode ranges except U+3007, which falls back to the system font. These are the
official MiSans Latin-script subsets of the MiSans family, not the separately
named MiSans Latin family. The service returns identical bytes for 600 and 650; both document and note
headings therefore use 600. Chinese continues to use the browser's system-font fallback.

`MiSans-Regular.ttf` is the historical input to `scripts/subset-misans.py`,
which creates the older `MiSans-Latin.woff2`. Those files are retained for
reproducibility; the reader uses the official slices instead. Font source files
are excluded from server/plugin ZIPs and Docker build contexts. PDF selection
fonts remain under the server's vendor assets.

MiSans is a Xiaomi font; its terms and attribution requirement are described in
the [official license](https://hyperos.mi.com/font/en/download/).
