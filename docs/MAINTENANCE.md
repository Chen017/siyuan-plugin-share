# Maintenance

## Boundaries and compatibility

The SiYuan plugin remains the no-build `index.js` / `index.css` entry point. Do not edit minified vendor libraries or change plugin API payloads as part of routine cleanup. Reader controls are English; note titles and contents retain their original language. Preserve reduced-motion support, lazy diagram loading, custom HTML/CSS/JS, PDF resource limits and upstream attribution.

The PHP application uses explicit, same-directory modules. Keeping them next to `index.php` preserves existing `__DIR__` paths and requires no framework or dependency installation:

| File | Responsibility |
| --- | --- |
| `index.php` | Configuration/session bootstrap, shared HTTP/layout helpers and route dispatch |
| `database.php` | Schema compatibility, settings and administrator seeding |
| `storage.php` | Attachments, staging, chunk cleanup, sync manifests and storage accounting |
| `sync.php` | Versioned plugin API, ownership, full and incremental synchronization |
| `markdown.php` | Markdown/emoji normalization and HTML sanitization |
| `share-access.php` | Password, expiration and persistent visitor permissions |
| `share-assets.php` | Permission-checked resource delivery and legacy attachment URLs |
| `reader.php` | Trees, reader home matching, notebook welcome and partial document responses |
| `admin.php` | Administrator web routes and settings |
| `pdf-export.php` / `pdf-visitor.php` | Independent PDF preparation, verification, quotas and leases |
| `legacy-cleanup.php` | Idempotent retirement of removed modules |

These files are loaded by the front controller; Nginx continues to deny execution of other PHP files. The split retains the existing function bodies and public routes. Browser rendering stays in `assets/app.js`; PDF composition and selectable text remain in their separate assets.

## Isolated validation

```sh
python tests/run.py --php /path/to/php-8.3
NODE_PATH=/path/to/isolated/node_modules node tests/frontend.cjs
NODE_PATH=/path/to/isolated/node_modules node tests/reader-ui.cjs
python tests/deploy-guard.py --bash /path/to/bash
```

The frontend suites use `jsdom@26.1.0`. PDF text-layer generation also uses `jspdf@4.0.0`; verify its generated documents with `pypdfium2==5.14.0` and `tests/pdf-text-layer.py`. These are isolated test dependencies, not application dependencies. CI installs them in the runner's temporary directory.

The PHP runner copies application code into a temporary directory, excludes real configuration/data, creates a disposable database and isolates native PHP session files. The Docker mode adds Nginx access rules, lifecycle and persistence checks. Browser PDF tests require their separate browser environment; an explicit skip does not mean they passed.

On `main`, deployment calls both reusable regression workflows and waits for both to succeed. Branch/PR and manual checks remain available. The Docker backup fixture tests the real worker's access to a configuration created with private permissions, restored file hashes, SQLite integrity and service resume. The deploy guard executes the real workflow shell against disposable mocks and confirms that a failed backup prevents cutover.

## Packages

`scripts/package.py` builds the plugin and server ZIPs without publishing. It includes every PHP module and the optional configuration example, public metadata and assets; it excludes local `config.php`, persisted data and test artifacts. `tests/package.py` verifies archive integrity and PHP include dependencies. The manual release workflow uses this same packager. No tag or release is created by the maintenance tests.

## Deployment and backups

See [source deployment](../README_DOCKER_BUILD.md) for normal installations. The maintainer workflow uses one VPS and its existing secrets. Builds and CI do not include `.test-output`, private branch bundles, backups or persisted application data.

`prepare-config.sh` resolves the worker group from the built image and makes only the configuration group-readable (640). Public files in Docker images and server ZIPs receive normal readable permissions even when the source checkout is private; mounted configuration/data retain their own permissions. CI reproduces the private source permissions before building. Container and Compose health checks verify the actual English sign-in HTML; HTTP 200 alone is insufficient. Temporary test logs, local previews, screenshots and private recovery bundles belong under ignored `.test-output/`. Real `storage`, `uploads` and `backups` are ignored too.

`backup-volumes.sh` delegates to `scripts/backup-data.sh`, detects data from the running container and supports both bind mounts and named volumes. It does not assume a Compose project/volume name or delete older backups. Application images and restored database snapshots are preserved privately. Custom data locations need a matching backup procedure; the standard script refuses to imply coverage it does not have.

For the administrator-only migration, the deployment guard additionally compares core data fingerprints before and after the switch. This includes notes, links, ownership/keys, visitor allowances, preserved settings and referenced attachment bytes. A schema rollback requires restoring the matching data backup, not only the previous image.

## Cleanup scope

The 2026-10-27 maintenance pass separates PHP responsibilities, removes unreachable helpers and confirmed obsolete styles, unifies backup and configuration-permission handling, aligns health checks, isolates test sessions, filters local artifacts from build context and corrects deployment documentation. It does not change sync contracts, stored note content, share IDs/URLs, PDF behavior or the no-build plugin format.

Historical branches are archived in a verified local Git bundle before removal. Keep `main`, the local `upstream` reference, and the owner's remote `upstream` reference; do not rewrite the actual upstream repository. The bundle also records branch tips and preserves any local PDF test patch separately. This private archive is not part of release packages or Docker builds.
