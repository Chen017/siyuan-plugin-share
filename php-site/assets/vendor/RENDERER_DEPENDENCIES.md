# Markdown and Mermaid renderer provenance

Both browser bundles below are the unmodified `dist/*.min.js` files from the official npm packages, downloaded with lifecycle scripts disabled. The npm tarball SHA-512 integrity values were verified before extracting the individual bundles. These files are committed so the reader and PDF export do not depend on a runtime CDN.

| Package | Version | Bundle SHA-256 | npm tarball integrity | License |
| --- | --- | --- | --- | --- |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 14.3.3 | `494ba53db1aac9f676317dda7062bd9545b5f0bbe3f12b0ab1ab4f813825cfb0` | `sha512-L//tDAkjTjJCU6pBUSBTgs3Kg4InVaZuUZog/b6V12UKhcDQ7S78877ibbCanRExwPuYP1CZD7Gd2dxSy1GXRg==` | MIT; `markdown-it.LICENSE.txt` |
| [mermaid](https://github.com/mermaid-js/mermaid) | 10.9.8 | `8d607d7ef1d077a8aa202e18e62212bfa992c68bfeabc5cf45d51a128fe6675d` | `sha512-gmIhmkmD/3DL5lErDV71E/cFUkEbBW4VTFpsJH1HSYjeBICRKOoc4AZem+RNz/FhhCXKBMZiD75bIfBlb2A4yA==` | MIT; `mermaid.LICENSE.txt` from the upstream v10.9.8 tag |

The update addresses the known markdown-it linkification and unclosed-reference complexity issues and the Mermaid Gantt and XY chart infinite-loop advisories. The Mermaid bundle contains DOMPurify 3.4.2; later DOMPurify advisories exist. Some require `IN_PLACE` or other specific configurations, and their applicability to Mermaid's bundled calls has not been fully assessed. This is not a complete embedded-dependency audit or a claim that the bundles have no other vulnerabilities. Review current upstream advisories on future updates and rerun `tests/render-security.cjs`, reader/diagram regressions and browser PDF tests.
