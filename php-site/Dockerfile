FROM php:8.1-fpm-alpine

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
        oniguruma-dev \
        sqlite-dev \
        zlib-dev; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" gd mbstring pdo pdo_sqlite zip; \
    apk del .build-deps; \
    mkdir -p /run/nginx /var/lib/nginx/tmp /var/log/nginx

WORKDIR /var/www/html

# Copy app files with runtime owner
COPY --chown=www-data:www-data php-site/ /var/www/html/

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
trap '_shutdown; exit 0' TERM INT

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
    CMD curl -sf http://127.0.0.1/login -o /dev/null

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

