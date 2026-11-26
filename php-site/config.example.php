<?php
// Optional installation overrides. Copy to config.php when deploying a server ZIP.
// The application supplies all defaults. Saved PDF settings take precedence over initial defaults.
return [
    'app_name' => 'SiYuan Share',
    'default_storage_limit_mb' => 1024,
    'session_lifetime_days' => 30,
    // 'db_path' => __DIR__ . '/storage/app.db',
    // 'uploads_dir' => __DIR__ . '/uploads',
    // Optional static token for a trusted localhost MCP gateway (strip X-MCP-Internal-Token on public reverse proxies).
    // Prefer setting MCP_INTERNAL_TOKEN / MCP_INTERNAL_USER_ID Docker environment variables (which override config.php):
    // 'mcp_internal_token' => '',
    // 'mcp_internal_user_id' => 1,
];
