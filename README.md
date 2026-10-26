# 🔗 Siyuan Share

[English](README.md) · [简体中文](README_zh_CN.md)

Share a SiYuan document, a document tree or a notebook through a web link, with passwords, expiration dates, visitor limits and incremental sync.

This is **[Chen017](https://github.com/Chen017)'s personal fork** of [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share). The original sharing features come from upstream; this fork focuses on reading, rendering fixes and self-hosting.

## ✨ What changed here

| Area | Personal changes |
| --- | --- |
| Runtime | PHP **8.3.36**, graceful Nginx/PHP-FPM shutdown, runtime and API regression checks. |
| Fonts | Local **MiSans** for Latin letters, digits and common punctuation; system fonts for Chinese. The Latin WOFF2 is **34 KB**, down from the original 8.1 MB TTF. |
| Reading | Neutral dark surfaces and clear blue links; reading statistics and comments hidden on share pages. Footer links lead with this fork and credit upstream. |
| Rendering | SiYuan table-cell alignment fixes, on-demand diagram engines and one Markdown render per document. Math, footnotes and diagrams remain available. |
| Accessibility & SEO | Clearer links, correct button states and TOC focus, main landmarks, working image-download controls, page descriptions, robots.txt and real 404 responses. |
| Deployment | Local-only `127.0.0.1:8081`, versioned static assets, GitHub Actions deployment and isolated regression tests. Backup and restore-verification scripts are included. |

Earlier changes and commit references: [Fork changes](CUSTOM_FEATURES.md) · [PHP upgrade record](docs/PHP83_BETA.md).

## 🚀 Self-host

With Docker and Docker Compose installed:

```sh
git clone https://github.com/Chen017/siyuan-plugin-share.git
cd siyuan-plugin-share
# Review php-site/config.php for your installation.
docker compose build --pull
docker compose up -d
```

The service listens on **`127.0.0.1:8081`**. Point your HTTPS reverse proxy at that address. SQLite data, uploads and configuration persist outside the container.

Registration and captcha are disabled in this fork's default configuration. Set up the administrator first, create an API key, then enter your own server URL and key in the SiYuan plugin.

## Using the plugin

1. Install **Siyuan Share** in SiYuan and configure your server URL and API key.
2. Right-click a document or notebook, then create a share.
3. Set its password, expiration or visitor limit as needed; copy the link to share it.

Update an existing share to keep its URL. Automatic and incremental sync are inherited from upstream. See the [upstream guide](https://github.com/b8l8u8e8/siyuan-plugin-share#readme) for the full plugin workflow.

## Contributions merged upstream

Chen017 also contributed [dark-mode code highlighting #38](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/38), [dark mode for login/admin/public pages #39](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/39), [custom HTML head insertion #45](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/45), and [nested-dollar KaTeX parsing #69](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/69). These are already part of upstream.

## Maintenance

- **`main`**: this fork's deployable code. **`upstream`**: the retained upstream reference branch.
- [PHP/Docker regression](.github/workflows/php83-regression.yml) and [reader regression](.github/workflows/frontend-regression.yml) use disposable test data.
- [Backup and rollback records](docs/VPS_UPGRADE_20261022.md) · [Upstream changelog](CHANGELOG.md).
- The deployment workflow targets the maintainer's VPS; configure your own Actions secrets before using it.

Original project by **b8l8u8e8 and contributors**. Personal fork maintained by **Chen017**. [MIT License](LICENSE).

## Guest PDF and individual batch downloads

Saved PDFs include the original document URL, author `塵`, and rights notice `随意传播，禁止售卖` in hidden XMP metadata and an invisible text layer on every page. No export identifier is added, and visible layout stays unchanged. Native browser printing does not guarantee preservation of this hidden information.

After opening a shared document, guests can use the PDF action beside Source. Export a document, subtree, shared scope or selected documents: Save triggers sequential browser downloads, **one independent PDF per document, without merging**. Light, dark and mobile exports always use white backgrounds.

Each server-issued visitor Cookie has its own rolling allowance, defaulting to 120 documents per 60 minutes; administrators may configure up to 256. Visitors sharing a campus or office IP do not share personal quotas. A new Cookie with an exactly matching recent fingerprint requires one server-verified CAPTCHA, then uses its own allowance without repeated verification during that Cookie's lifetime. CAPTCHA never refills an exhausted Cookie's quota. Anonymous Cookies and fingerprints cannot reliably identify natural persons.

A server-side transaction permits only one active export task per visitor Cookie, including across tabs, windows and website sessions. Existing access/password/expiry checks and preset concurrency, batch and resource limits remain in place.

Direct downloads preserve visual layout as page images, so text is generally not selectable. Native Print this document remains available for selectable text. Browsers may ask permission for multiple downloads. See [configuration, limitations and tests](docs/GUEST_PDF_EXPORT.md).
