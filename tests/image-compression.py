"""Unit and integration checks for image compression (TinyPNG-like optimization)."""
from pathlib import Path
import re
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def test_dockerfile_dependencies():
    dockerfile = (ROOT / 'php-site/Dockerfile').read_text(encoding='utf-8')
    for pkg in ['pngquant', 'jpegoptim', 'libwebp', 'libwebp-tools']:
        assert pkg in dockerfile, f'Missing package {pkg} in Dockerfile'
    assert '--with-webp' in dockerfile, 'Missing --with-webp in docker-php-ext-configure gd'
    print('Dockerfile dependencies check passed.')


def test_database_schema_and_migration():
    with tempfile.TemporaryDirectory(prefix='siyuan-test-img-') as td:
        db_path = Path(td) / 'test.db'
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()

        # Create base share_assets table like old version
        cur.execute('''CREATE TABLE share_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            share_id INTEGER NOT NULL,
            doc_id TEXT,
            asset_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            asset_hash TEXT,
            created_at TEXT NOT NULL
        )''')

        # Run migration logic (simulated ensure_column)
        cur.execute("PRAGMA table_info(share_assets)")
        cols = {row[1] for row in cur.fetchall()}
        assert 'compressed_at' not in cols
        assert 'original_size_bytes' not in cols

        # Add columns
        cur.execute("ALTER TABLE share_assets ADD COLUMN compressed_at TEXT")
        cur.execute("ALTER TABLE share_assets ADD COLUMN original_size_bytes INTEGER NOT NULL DEFAULT 0")

        cur.execute("PRAGMA table_info(share_assets)")
        new_cols = {row[1] for row in cur.fetchall()}
        assert 'compressed_at' in new_cols
        assert 'original_size_bytes' in new_cols
        conn.close()
    print('Database migration test passed.')


def test_compression_stats_queries():
    with tempfile.TemporaryDirectory(prefix='siyuan-test-img-') as td:
        db_path = Path(td) / 'test.db'
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()

        cur.execute('''CREATE TABLE share_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            share_id INTEGER NOT NULL,
            doc_id TEXT,
            asset_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            asset_hash TEXT,
            compressed_at TEXT,
            original_size_bytes INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )''')

        # Insert test data:
        # 1. Compressed PNG: orig 1000, curr 300
        cur.execute("INSERT INTO share_assets (share_id, asset_path, file_path, size_bytes, original_size_bytes, compressed_at, created_at) VALUES (1, 'assets/pic1.png', 'shares/1/v1/pic1.png', 300, 1000, '2026-11-05 12:00:00', '2026-11-05 11:00:00')")
        # 2. Uncompressed JPG: orig 0, curr 2000
        cur.execute("INSERT INTO share_assets (share_id, asset_path, file_path, size_bytes, original_size_bytes, compressed_at, created_at) VALUES (1, 'assets/pic2.jpg', 'shares/1/v1/pic2.jpg', 2000, 0, NULL, '2026-11-05 11:00:00')")
        # 3. Non-image TXT file: orig 0, curr 500, compressed_at set to skip
        cur.execute("INSERT INTO share_assets (share_id, asset_path, file_path, size_bytes, original_size_bytes, compressed_at, created_at) VALUES (1, 'assets/note.txt', 'shares/1/v1/note.txt', 500, 500, '2026-11-05 12:00:00', '2026-11-05 11:00:00')")
        conn.commit()

        # Query stats using the exact filter in image-compression.php
        image_filter = " (LOWER(SUBSTR(asset_path, -4)) IN ('.png', '.jpg', '.gif') OR LOWER(SUBSTR(asset_path, -5)) IN ('.jpeg', '.webp'))"
        cur.execute(f"SELECT COUNT(*) FROM share_assets WHERE {image_filter}")
        total_images = cur.fetchone()[0]
        assert total_images == 2, f'Expected 2 images, got {total_images}'

        cur.execute(f"SELECT COUNT(*) FROM share_assets WHERE compressed_at IS NULL AND {image_filter}")
        pending_images = cur.fetchone()[0]
        assert pending_images == 1, f'Expected 1 pending image, got {pending_images}'

        cur.execute(f"""SELECT COUNT(*),
            COALESCE(SUM(CASE WHEN original_size_bytes > 0 THEN original_size_bytes ELSE size_bytes END), 0) AS total_orig,
            COALESCE(SUM(size_bytes), 0) AS total_curr
        FROM share_assets
        WHERE compressed_at IS NOT NULL AND {image_filter}""")
        comp_count, total_orig, total_curr = cur.fetchone()
        assert comp_count == 1
        assert total_orig == 1000
        assert total_curr == 300
        assert total_orig - total_curr == 700  # 700 bytes saved
        conn.close()
    print('Compression stats queries test passed.')


def test_php_code_integrity():
    files = [
        ROOT / 'php-site/image-compression.php',
        ROOT / 'php-site/background-compress.php',
        ROOT / 'php-site/database.php',
        ROOT / 'php-site/sync.php',
        ROOT / 'php-site/storage.php',
        ROOT / 'php-site/admin.php',
        ROOT / 'php-site/index.php',
    ]
    for f in files:
        assert f.is_file(), f'File not found: {f}'
        content = f.read_text(encoding='utf-8')
        assert 'declare(strict_types=1);' in content, f'Missing strict_types in {f.name}'
    
    # Check that image-compression functions are referenced properly
    sync_code = (ROOT / 'php-site/sync.php').read_text(encoding='utf-8')
    assert 'compress_image_file' in sync_code
    assert 'is_compressible_image_path' in sync_code

    storage_code = (ROOT / 'php-site/storage.php').read_text(encoding='utf-8')
    assert 'compress_image_file' in storage_code
    assert 'is_compressible_image_path' in storage_code

    admin_code = (ROOT / 'php-site/admin.php').read_text(encoding='utf-8')
    assert '/admin/images/compress' in admin_code
    assert '/admin/images/compress-stop' in admin_code
    assert '/admin/images/status' in admin_code
    assert 'render_image_compression_admin_section' in admin_code
    print('PHP code integrity check passed.')


if __name__ == '__main__':
    test_dockerfile_dependencies()
    test_database_schema_and_migration()
    test_compression_stats_queries()
    test_php_code_integrity()
    print('All image compression checks passed!')
