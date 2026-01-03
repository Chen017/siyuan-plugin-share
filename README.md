# SiYuan Share (siyuan-plugin-share)

Export SiYuan documents/notebooks to Markdown and upload to the PHP site to generate share links.

## Features

- Share documents and notebooks (Markdown + assets)
- Manage shares from the document tree (right click or share icon)
- Multi-user site with registration, admin, and announcements
- Share pages render Markdown + KaTeX + code highlighting + task lists
- Image captcha, email verification, and password reset (SMTP optional)

## Server Setup

1. Deploy `php-site` to a PHP 7.4+ server.
2. Ensure `php-site/storage` and `php-site/uploads` are writable.
3. Image captcha requires the GD extension (or disable captcha in admin settings).
4. (Optional) Copy `php-site/config.example.php` to `php-site/config.php`.
5. Default admin account: `admin/123456` (change it on first login).
6. Configure SMTP, registration, and captcha in the admin panel.

## Admin Features

- User enable/disable, per-user storage limits, and share browsing
- Share soft delete/restore/hard delete
- Site settings: default limit, registration, captcha, email verification, SMTP
- Announcements
- One-click data reset for testing

## Nginx Example

```nginx
server {
  listen 80;
  server_name example.com;
  root /var/www/share;
  index index.php index.html;

  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }

  location ~ \.php$ {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass 127.0.0.1:9000;
  }
}
```

## Plugin Setup

- Site URL: `https://example.com` (include subdirectory if any)
- API Key: copy from dashboard

Click “Verify & Sync” to pull remote shares.

## Usage

- Use the doc tree context menu or share icon to manage shares
- Update/copy/delete shares from the dialog
- Every action verifies the API Key first

## Sync & Deletion

- Clearing the site URL or API Key / clicking Disconnect clears local shares
- Reconnect to sync remote shares again

## Assets

Markdown `assets/` are uploaded and kept as relative paths.
