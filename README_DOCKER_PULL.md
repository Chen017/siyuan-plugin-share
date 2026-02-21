# 思源笔记分享服务 - Docker Compose 部署指南（直拉镜像）

本文档使用 `docker compose` 直接拉取并运行镜像，不需要本地构建镜像。

## 前置要求

- Docker 20.10+
- Docker Compose v2（命令为 `docker compose`）
- 可访问 Docker Hub 的网络环境

检查安装：

```bash
docker --version
docker compose version
```

## 快速启动

### 1. 准备目录

```bash
# 可按需替换为你自己的部署目录
mkdir -p ~/siyuan-share/php-site/storage ~/siyuan-share/php-site/uploads
cd ~/siyuan-share
```

### 2. 创建 `docker-compose.yml`

将以下内容保存为 `docker-compose.yml`：

```yaml
services:
  web:
    image: b8l8u8e8/siyuan-share-web:latest
    container_name: siyuan-share-web
    ports:
      - "38080:80"
    volumes:
      - ./php-site/storage:/var/www/html/storage
      - ./php-site/uploads:/var/www/html/uploads
      # 如果你需要自定义配置，再取消下面这行注释
      # - ./php-site/config.php:/var/www/html/config.php:ro
    environment:
      TZ: Asia/Shanghai
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

### 3. 拉取镜像并启动

```bash
docker compose pull
docker compose up -d
```

### 4. 查看状态与日志

```bash
docker compose ps
docker compose logs -f
```

### 5. 访问服务

浏览器打开：`http://服务器IP:38080`

默认管理员账号：

- 用户名：`admin`
- 密码：`123456`

首次登录后请立即修改密码。

## 可选：启用自定义 `config.php`

如果你要修改站点配置，可以先从镜像中导出 `config.example.php`：

```bash
cd ~/siyuan-share
docker create --name sps-config-tmp b8l8u8e8/siyuan-share-web:latest
docker cp sps-config-tmp:/var/www/html/config.example.php ./php-site/config.php
docker rm sps-config-tmp
```

然后编辑 `./php-site/config.php`，并在 `docker-compose.yml` 中取消这行注释：

```yaml
- ./php-site/config.php:/var/www/html/config.php:ro
```

最后重启容器：

```bash
docker compose up -d
```

## 常用运维命令

查看服务状态：

```bash
docker compose ps
```

查看最近日志：

```bash
docker compose logs --tail=200 web
```

重启服务：

```bash
docker compose restart
```

停止服务：

```bash
docker compose stop
```

删除容器（不会删除挂载数据）：

```bash
docker compose down
```

## 更新应用

```bash
cd ~/siyuan-share
docker compose pull
docker compose up -d --remove-orphans
```

## 备份与恢复

备份：

```bash
cd ~/siyuan-share
tar -czf backup-$(date +%Y%m%d).tar.gz \
  php-site/storage \
  php-site/uploads
```

如果启用了自定义配置，建议一起备份：

```bash
tar -czf backup-$(date +%Y%m%d).tar.gz \
  php-site/storage \
  php-site/uploads \
  php-site/config.php
```

恢复：

```bash
cd ~/siyuan-share
tar -xzf backup-20260114.tar.gz
docker compose up -d
```

## 故障排查

### 1) 镜像拉取失败

- 检查网络是否可访问 Docker Hub
- 检查镜像名是否正确：`b8l8u8e8/siyuan-share-web:latest`

### 2) 端口冲突

如果 `38080` 被占用，将 `docker-compose.yml` 中端口映射改为：

```yaml
ports:
  - "39180:80"
```

### 3) 目录权限问题

```bash
sudo chown -R $(id -u):$(id -g) ~/siyuan-share/php-site/storage ~/siyuan-share/php-site/uploads
chmod -R 775 ~/siyuan-share/php-site/storage ~/siyuan-share/php-site/uploads
```

### 4) 健康检查异常

```bash
docker inspect siyuan-share-web --format '{{json .State.Health}}'
```

## 注意事项

1. 持久化数据请务必备份：`php-site/storage`、`php-site/uploads`（以及可选的 `php-site/config.php`）。
2. 生产环境建议配置反向代理并启用 HTTPS。
3. 首次上线后请立刻修改默认管理员密码。
