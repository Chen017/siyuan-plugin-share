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

Uploads validate and publish original bytes in an isolated generation first. Background optimization is queued after commit and the response; encoders do not run inside the upload's SQLite write transaction. Quotas initially count the original bytes and are reduced after a successful optimization.

- **Atomic publication**: Historical images are copied before encoding. After processing, the original database reference and file hash are checked again under `ShareFileWrite`. A strictly smaller, format- and dimension-compatible result is published in a new generation. File references, attachment size, share size and user storage commit together. SQL failure preserves the old published bytes; cleanup removes only replaced files with no remaining reference.
- **Client hashes**: `share_assets.asset_hash` always describes the original client bytes. Optimization never replaces it with the stored image hash, so unchanged images remain unchanged to incremental sync.
- **Image behavior**: PNG palette quantization is lossy and may alter colors. The GD fallback only recompresses ordinary PNGs. JPEG and WebP use lossless encoders with metadata retained. Animated PNG/WebP and PNGs with protected color/orientation metadata are left intact. Actual file type, dimensions, a 16-million-pixel/memory budget and a per-encoder 20-second deadline are checked before replacement. Missing safe encoders keep images pending and report failure.
- **Task lifecycle**: One OS worker lock and a distinct job ID protect both HTTP and CLI execution. State changes use a separate lock and atomic JSON replacement. Stop requests are preserved and honored after the current image; no arbitrary PID is signalled. A cursor ensures every failed or missing image is attempted at most once per run, while later and newly uploaded images continue. Failed images remain available for an explicit retry.
- **Status and verification**: `Smaller images` counts actual savings, while pending review excludes unsupported GIFs and already-reviewed preserved images. Progress polling uses authenticated, uncached responses and does not reload forms. Full backup fingerprints include compression metadata; deployment core fingerprints use stable columns and include the administrator authentication mode.
