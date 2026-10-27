# Upload and reader safeguards

Attachments are written into a new generation and become visible only when the database commits. Existing attachment URLs continue to resolve through the database. A failed update keeps the previous note and files; an old upload receives HTTP 409 if the share changed after initialization. Restart that upload to use the current password, expiration, visitor limit and content revision.

Upload requests are serialized per upload ID. Expired staging rows and files are reclaimed together, excluding a task currently holding its request lock. Initialization runs bounded cleanup; other authenticated API requests retain probabilistic cleanup. Defaults are 2 hours without activity, at most 32 pending tasks per owner and 1 GiB reserved source/attachment bytes per owner (or a lower configured storage limit). Chunk bytes cannot exceed their declared asset size. Uploads also leave at least 16 MiB of free space.

Optional instance configuration:

```php
'upload_pending_limit' => 32,
'upload_staging_limit_mb' => 1024,
```

Temporary copies and old/new attachment generations can coexist during an update, so reserve additional disk capacity. SQL rollback cannot undo a filesystem change; generation cleanup intentionally happens after commit.

Search, reader pages and attachment downloads share atomic admission for visitor-limited shares. A search that returns content now occupies a visitor slot. Existing registered visitors retain access. Unlimited shares do not acquire an admission write lock. Anonymous visitor limits remain cookie-based and do not identify natural persons.

Mermaid renders locally. Diagram failures show the source instead of transmitting it to an external service. PlantUML currently shows its source because no local PlantUML engine is bundled. The website no longer submits diagram source to plantuml.com or mermaid.ink, including during PDF export.

Plugin 0.5.6 restricts authenticated icon fetches to the current SiYuan origin's `/api/` paths and refuses redirects. External icons remain ordinary image links without the SiYuan token. Updating the website does not install the plugin into a SiYuan workspace; install the corresponding plugin package too.
