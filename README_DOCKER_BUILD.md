# 思源笔记分享服务 - Docker 部署指南

本文档介绍如何使用 Docker Compose 快速部署思源笔记分享服务,替代宝塔等传统部署方式。

## 📋 前置要求

- Docker 20.10+
- Docker Compose 1.29+
- git

安装 Docker:
```bash
# macOS (使用 Homebrew)
brew install --cask docker

# Linux (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 或访问 https://docs.docker.com/get-docker/
```

## 🚀 快速启动

### 1.获取源码文件

获取用于搭建网站的源码文件。

```bash
#从仓库拉取源码。如果不使用 Git，也可以直接下载仓库的压缩包，解压后放到当前目录，效果是一样的。
git clone https://github.com/b8l8u8e8/siyuan-plugin-share.git
```

### 2. 配置文件准备

首先,复制示例配置文件(必须复制):

```bash
# 下侧/Users/quxiaopang/以自己的为准
cd /Users/quxiaopang/siyuan-plugin-share
cp php-site/config.example.php php-site/config.php
```

编辑 `php-site/config.php` 根据需要调整配置(可不改):

```php
<?php
return [
    'app_name' => '思源笔记分享',
    'allow_registration' => true,
    'default_storage_limit_mb' => 1024,
    // ... 其他配置
];
```

### 3. 构建并启动服务

```bash
# 构建 Docker 镜像
docker-compose build

# 启动服务 (后台运行)
docker-compose up -d

# 查看日志
docker-compose logs -f
```

### 4. 访问应用

打开浏览器访问: **http://localhost:8080**

默认管理员账号:
- 用户名: `admin`
- 密码: `123456` (首次登录会要求修改密码)

## 📁 目录结构

```
siyuan-plugin-share/
├── docker-compose.yml          # Docker Compose 配置
├── .dockerignore              # Docker 忽略文件
└── php-site/
    ├── Dockerfile             # PHP 应用容器配置
    ├── config.php            # 应用配置 (需手动创建)
    ├── config.example.php    # 配置示例
    ├── storage/              # SQLite 数据库 (自动创建)
    └── uploads/              # 用户上传文件 (自动创建)
```

## 🔧 常用命令

```bash
# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs -f web

# 重启服务
docker-compose restart

# 停止服务
docker-compose stop

# 停止并删除容器
docker-compose down

# 重新构建镜像
docker-compose build --no-cache

# 进入容器内部
docker-compose exec web sh
```

## 🔄 更新应用

```bash
# 使用 Git 拉取最新源码；
# 如果不使用 Git，也可以直接下载仓库的最新压缩包，解压后覆盖当前目录中的源码。
#
# 如果拉取时提示冲突（conflict），说明：
# 你本地修改过的文件，刚好也在云端被更新了。
# 为了防止你的修改被直接覆盖，Git 会要求你先确认如何处理。
#
# 这是正常现象，不是报错。
# 根据提示处理完成后，再次执行 git pull 即可。
git pull

# 停止服务
docker-compose down

# 重新构建镜像
docker-compose build

# 启动服务
docker-compose up -d
```

## 💾 数据备份

重要数据都存储在以下目录,请定期备份:

```bash
# 备份数据库和上传文件
tar -czf backup-$(date +%Y%m%d).tar.gz \
    php-site/storage \
    php-site/uploads \
    php-site/config.php

# 恢复备份
tar -xzf backup-20260114.tar.gz
```

## 🌐 生产环境部署

### 使用 Nginx 反向代理

如果需要使用域名和 HTTPS,建议在前面加一层 Nginx:

```nginx
server {
    listen 80;
    server_name share.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 修改端口映射

编辑 `docker-compose.yml`:

```yaml
ports:
  - "80:80"  # 直接使用 80 端口
  # 或
  - "3000:80"  # 使用其他端口
```

## ⚙️ 环境变量配置

可以在 `docker-compose.yml` 中添加环境变量:

```yaml
environment:
  - TZ=Asia/Shanghai
  # 若需调整 PHP 上传和内存限制，请直接修改 Dockerfile 中 uploads.ini 的值并重建镜像
```

## 🐛 故障排查

### 查看详细日志

```bash
docker-compose logs -f --tail=100 web
```

### 检查容器健康状态

```bash
docker-compose ps
docker inspect siyuan-share-web | grep -A 10 Health
```

### 权限问题

如果遇到文件权限问题:

```bash
sudo chown -R $(id -u):$(id -g) php-site/storage php-site/uploads
chmod -R 775 php-site/storage php-site/uploads
```

### 端口已被占用

如果 8080 端口被占用,修改 `docker-compose.yml`:

```yaml
ports:
  - "8081:80"  # 改用其他端口
```

## 📊 性能优化

### 资源限制

在 `docker-compose.yml` 中添加资源限制:

```yaml
services:
  web:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 256M
```

### 启用 OPcache

在当前 Dockerfile 中，将现有扩展安装行改为:

```dockerfile
RUN docker-php-ext-install -j"$(nproc)" gd pdo pdo_sqlite zip opcache
```

## 📝 注意事项

1. **数据持久化**: `storage/` 和 `uploads/` 目录通过卷挂载,容器删除后数据仍会保留
2. **配置文件**: `config.php` 以只读方式挂载,修改后需重启容器
3. **安全性**: 生产环境请务必修改默认密码,并配置 HTTPS
4. **备份**: 定期备份 SQLite 数据库和上传文件

## 🔗 相关链接

- [Docker 官方文档](https://docs.docker.com/)
- [Docker Compose 文档](https://docs.docker.com/compose/)
- [原项目 README](README_zh_CN.md)
