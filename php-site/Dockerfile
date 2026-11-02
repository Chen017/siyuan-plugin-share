# Build the same source files served by the PHP image, retaining their URLs.
FROM node:24-alpine AS asset-build
WORKDIR /build
RUN npm install --no-save --no-package-lock --ignore-scripts terser@5.44.0 clean-css@5.3.3
COPY scripts/minify-css.cjs /build/minify-css.cjs
COPY php-site/assets/ /build/assets/
RUN set -e; for f in app.js controls.js pdf-export.js pdf-text-layer.js; do \
      ./node_modules/.bin/terser "assets/$f" --compress --mangle --output "assets/$f.min" && mv "assets/$f.min" "assets/$f"; \
    done && node /build/minify-css.cjs assets/style.css assets/controls.css assets/pdf-export.css

FROM php:8.3.36-fpm-alpine

# Install runtime packages + build deps, compile PHP extensions, then remove build deps
RUN set -eux; \
    apk add --no-cache \
        curl \
        nginx \
        freetype \
        libjpeg-turbo \
        libpng \
        libzip \
        oniguruma \
        sqlite-libs \
        zlib; \
    apk add --no-cache --virtual .build-deps \
        $PHPIZE_DEPS \
        freetype-dev \
        libjpeg-turbo-dev \
        libpng-dev \
        libzip-dev \
        zlib-dev; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    php -r 'foreach (["mbstring", "PDO", "pdo_sqlite"] as $ext) { if (!extension_loaded($ext)) { fwrite(STDERR, "$ext is required in the base image\n"); exit(1); } }'; \
    docker-php-ext-install -j"$(nproc)" gd zip; \
    apk del .build-deps; \
    mkdir -p /run/nginx /var/lib/nginx/tmp /var/log/nginx

WORKDIR /var/www/html

# Copy app files with runtime owner
COPY --chown=www-data:www-data php-site/ /var/www/html/
COPY --from=asset-build --chown=www-data:www-data /build/assets/ /var/www/html/assets/
# Hash the final bytes, so independent assets retain their cache keys across releases.
RUN php -r '$root="/var/www/html/assets/"; $it=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)); $out=[]; foreach($it as $file) { if ($file->isFile()) { $path=substr($file->getPathname(), strlen($root)); $out[$path]=substr(hash_file("sha256", $file->getPathname()),0,16); } } file_put_contents($root.".asset-versions.json", json_encode($out));'

# Build context files may come from a private umask-077 checkout. Nginx and FPM
# run as different users; normalize shipped code/assets, excluding mounted private data/config.
RUN find /var/www/html -type d -exec chmod 755 {} + \
    && find /var/www/html -type f -exec chmod 644 {} +

# Configure PHP runtime limits
RUN set -eux; \
    { \
        echo "upload_max_filesize = 100M"; \
        echo "post_max_size = 100M"; \
        echo "memory_limit = 256M"; \
        echo "max_execution_time = 300"; \
    } > /usr/local/etc/php/conf.d/uploads.ini

# Configure nginx
RUN cat > /etc/nginx/nginx.conf <<'NGINXCONF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /run/nginx/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    sendfile on;
    keepalive_timeout 65;
    client_max_body_size 100m;
    server_tokens off;
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json text/plain image/svg+xml;

    map $arg_v $asset_cache_control {
        default "public, max-age=604800";
        "~^[0-9a-f]{16}$" "public, max-age=31536000, immutable";
    }

    access_log /var/log/nginx/access.log;

    include /etc/nginx/conf.d/*.conf;
}
NGINXCONF

RUN mkdir -p /etc/nginx/conf.d && cat > /etc/nginx/conf.d/default.conf <<'SERVERCONF'
server {
    listen 80;
    server_name _;

    root /var/www/html;
    index index.php;

    # Runtime storage is private, including SQLite journals and temporary files.
    location = /storage { return 404; }
    location ^~ /storage/ { return 404; }

    # Deny hidden files and sensitive config/db files
    location ~ /\.(?!well-known) {
        deny all;
    }

    location ~* ^/(config\.php|config\.example\.php)$ {
        deny all;
    }

    location ~* \.db$ {
        deny all;
    }

    # Keep original behavior: uploads are always routed to index.php for permission checks
    location ^~ /uploads/ {
        rewrite ^ /index.php?$query_string last;
    }

    # Public application assets only; uploaded attachments retain their permission checks.
    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control $asset_cache_control;
    }

    # Existing files/directories are served directly, otherwise route to index.php
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location = /index.php {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root/index.php;
        fastcgi_param SCRIPT_NAME /index.php;
        fastcgi_param HTTP_AUTHORIZATION $http_authorization;
        fastcgi_param HTTP_X_API_KEY $http_x_api_key;
        fastcgi_pass 127.0.0.1:9000;
        fastcgi_read_timeout 300;
    }

    # Prevent direct execution of any other php files
    location ~ \.php$ {
        return 404;
    }
}
SERVERCONF

# Runtime entrypoint
RUN cat > /usr/local/bin/docker-entrypoint.sh <<'ENTRYPOINT'
#!/bin/sh
set -eu

mkdir -p /var/www/html/storage /var/www/html/uploads /run/nginx /var/lib/nginx/tmp /var/log/nginx
chown -R www-data:www-data /var/www/html/storage /var/www/html/uploads
chmod -R 775 /var/www/html/storage /var/www/html/uploads

# Start both processes and keep their PIDs for signal forwarding.
php-fpm --nodaemonize &
FPM_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

# Graceful shutdown handler for SIGTERM/SIGINT.
_shutdown() {
    kill -QUIT "$NGINX_PID" 2>/dev/null || true
    kill -TERM "$FPM_PID" 2>/dev/null || true
    wait "$NGINX_PID" "$FPM_PID" 2>/dev/null || true
}
trap '_shutdown; exit 0' TERM INT QUIT

# Exit container if either process exits unexpectedly.
while kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$FPM_PID" 2>/dev/null; do
    sleep 5
done
_shutdown
exit 1
ENTRYPOINT
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 同时探测 nginx 和 PHP-FPM，login 是 PHP 路由，200 表示 FPM 正常
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1/login | grep -F '<h1>Sign in</h1>' >/dev/null

EXPOSE 80

# The FPM base image defaults to SIGQUIT; our PID 1 supervises both services.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

