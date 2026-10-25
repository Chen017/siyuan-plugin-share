<?php
return [
    'app_name' => '思源笔记分享',
    'allow_registration' => false,
    'default_storage_limit_mb' => 1024,
    // Session lifetime (days)
    'session_lifetime_days' => 30,
    // Initial PDF defaults only. After first startup, manage these in Admin > Site settings.
    // Existing database settings take precedence and are never overwritten by this file.
    'pdf_export_enabled' => true,
    'pdf_export' => [
        'window_seconds' => 3600,
        'requests' => 5,
        'max_concurrent' => 4,
        'lease_seconds' => 180,
        'max_docs' => 30,
        'max_markdown_bytes' => 2097152,
        'max_html_bytes' => 8388608,
        'max_asset_bytes' => 52428800,
        'max_images' => 200,
        'max_execution_seconds' => 15,
        'max_memory_bytes' => 134217728,
        'max_window_events' => 20000,
    ],
    // Exact proxy peer IPs only. The proxy MUST overwrite this single-IP header.
    'pdf_export_trusted_proxies' => [],
    'pdf_export_ip_header' => 'HTTP_X_REAL_IP',
    // Chunk cleanup (seconds, 0.05 = 5% probability per request)
    'chunk_ttl_seconds' => 7200,
    'chunk_cleanup_probability' => 0.05,
    'chunk_cleanup_limit' => 20,
    // Upload chunk size limits (plugin will adapt to these values)
    'min_chunk_size_kb' => 256,
    'max_chunk_size_mb' => 8,
    'captcha_enabled' => false,
    'email_verification_enabled' => false,
    'email_from' => 'no-reply@example.com',
    'email_from_name' => '思源笔记分享',
    'email_subject' => '邮箱验证码',
    'email_reset_subject' => '重置密码验证码',
    'smtp_enabled' => false,
    'smtp_host' => '',
    'smtp_port' => 587,
    'smtp_secure' => 'tls',
    'smtp_user' => '',
    'smtp_pass' => '',
    // 'db_path' => __DIR__ . '/storage/app.db',
    // 'uploads_dir' => __DIR__ . '/uploads',

    // Site version shown in dashboard header, 不要改动此项
    'site_version' => '0.5.3',
    // Central stats server used for update heartbeat, 不要改动此项
    'central_stats_url' => 'https://share.b0x.top',
];
