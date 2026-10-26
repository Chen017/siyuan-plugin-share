# MiSans source font

`MiSans-Regular.ttf` is the original input to `scripts/subset-misans.py`.
Its bytes, copyright and embedded name/license records are preserved from the
previous `php-site/assets/MiSans-Regular.ttf` file.

The reader uses the generated `php-site/assets/MiSans-Latin.woff2` for Latin text
and system fonts for Chinese. Source fonts are excluded from server/plugin ZIPs
and Docker build contexts. PDF fonts remain under the server's vendor assets.

Regenerate from the repository root with Python and `fonttools[woff]` available:

```sh
python scripts/subset-misans.py
```
