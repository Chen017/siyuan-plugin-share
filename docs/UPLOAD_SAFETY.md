# Upload and reader safeguards

Attachments are written into a new generation and become visible only when the database commits. Existing attachment URLs continue to resolve through the database. A failed update keeps the previous note and files; an old upload receives HTTP 409 if the share changed after initialization. Restart that upload to use the current password, expiration and content revision.

Upload requests are serialized per upload ID. Expired staging rows and files are reclaimed together, excluding a task currently holding its request lock. Initialization runs bounded cleanup; other authenticated API requests retain probabilistic cleanup. Defaults are 2 hours without activity, at most 32 pending tasks per owner and 1 GiB reserved source/attachment bytes per owner (or a lower configured storage limit). Chunk bytes cannot exceed their declared asset size. Uploads also leave at least 16 MiB of free space.

Optional instance configuration:

```php
'upload_pending_limit' => 32,
'upload_staging_limit_mb' => 1024,
```

Temporary copies and old/new attachment generations can coexist during an update, so reserve additional disk capacity. SQL rollback cannot undo a filesystem change; generation cleanup intentionally happens after commit.

Search, reader pages and attachment downloads check the current password and expiration without registering share visitors or acquiring admission write locks. Legacy visitor-limit request fields are ignored. PDF export keeps its separate cookie identity and rolling quota.

SVG and other XML/HTML-like inline attachments remain viewable, but their response uses a CSP sandbox that blocks scripts and isolates the document origin. The decision uses the detected MIME type as well as the filename, so an SVG named `.png` is protected too. SVG charts rendered as images remain supported; embedded scripts and interactive SVG behavior are intentionally disabled. Other ordinary image and PDF previews do not receive this sandbox policy.

Mermaid renders locally. Diagram failures show the source instead of transmitting it to an external service. PlantUML currently shows its source because no local PlantUML engine is bundled. The website no longer submits diagram source to plantuml.com or mermaid.ink, including during PDF export.

Plugin 0.5.6 restricts authenticated icon fetches to the current SiYuan origin's `/api/` paths and refuses redirects. External icons remain ordinary image links without the SiYuan token. Updating the website does not install the plugin into a SiYuan workspace; install the corresponding plugin package too.

Automatic deployment follows the operator's no-backup policy: it retains neither a rollback image nor a persistent data archive. It pauses writes, compares temporary before/after data fingerprints, checks SQLite integrity and foreign keys, and removes the temporary verification files. A failed preflight resumes the stopped service. Manual backup scripts remain available as an optional operator action.

## Image compression safeguards

Image compression operates on staged assets within the isolated version generation before commit, or via manual batch processing in the administration interface:
- **Atomicity and fallback**: Optimization only replaces target files in place if the compressed file size is strictly smaller than the original (`--skip-if-larger`). When a compression tool is unavailable, fails, or produces larger output, the original uncompressed file is preserved untouched.
- **Client hash preservation**: The database retains the client-computed uncompressed SHA-256 hash in `share_assets.asset_hash`. Because the SiYuan plugin compares local asset hashes against the remote snapshot during incremental synchronization, keeping the original hash prevents unchanged images from being repeatedly re-exported or re-uploaded.
- **Quota synchronization**: When compression reduces attachment sizes, `size_bytes` on `share_assets`, the parent share, and the user's allocated storage are updated to reflect the actual disk usage.
- **Admin batch optimization**: The administrative interface allows triggering on-demand optimization for uncompressed or previously skipped images in bounded batches, ensuring large archives can be optimized without request timeouts.

