# 思源笔记分享服务 - Docker 部署指南（纯 Docker 命令版）

> 此指南展示上游预构建 Docker Hub 镜像的安装方式，不代表本 fork 当前的管理员专用代码。部署本 fork 请使用[源码构建指南](README_DOCKER_BUILD.md)。上游镜像配置与功能以所选标签为准。

本文档仅使用 `docker` 命令部署，不使用其他编排工具。

## 📋 前置要求

- Docker 20.10+
- 可访问 Docker Hub 的网络环境

检查安装：

```bash
docker --version
```

## 🚀 快速启动

### 1. 准备工作目录

```bash
# 下方 `~` 可替换为你的实际部署目录，后续命令请保持一致
mkdir -p ~/siyuan-share/php-site/storage ~/siyuan-share/php-site/uploads
cd ~/siyuan-share
```

> ⚠️ 除特别说明外，后续命令默认都在部署目录执行（示例：`~/siyuan-share`）。
> 如果你把路径改成了其他目录，请先 `cd` 到对应目录再执行命令。

### 2. 配置文件说明（可选）

`config.php` 不是必需文件。  
你可以先不创建，直接用默认配置启动容器。

只有在你需要自定义参数时（例如改应用名、上传目录、分片参数等），再创建并挂载 `config.php`。

### 3. 拉取镜像

```bash
docker pull b8l8u8e8/siyuan-share-web:latest
```

### 4. 启动容器

```bash
# 请先进入部署目录（示例：cd ~/siyuan-share）
docker run -d \
  --name siyuan-share-web \
  --restart unless-stopped \
  -p 38080:80 \
  -e TZ=Asia/Shanghai \
  -v "$(pwd)/php-site/storage:/var/www/html/storage" \
  -v "$(pwd)/php-site/uploads:/var/www/html/uploads" \
  --health-cmd="curl -f http://localhost/ || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  --health-start-period=40s \
  b8l8u8e8/siyuan-share-web:latest
```

### 5. 查看日志

```bash
docker logs -f siyuan-share-web
```

### 6. 访问应用

浏览器打开：`http://服务器IP:38080`

默认管理员账号：

- 用户名：`admin`
- 密码：`123456`

首次登录后请立即修改密码。

## 📁 数据目录说明

- `php-site/storage`：数据库等持久化数据
- `php-site/uploads`：上传文件
- `php-site/config.php`：可选站点配置（仅在你需要自定义时才挂载）

## ⚙️ 可选：启用自定义 `config.php`

如果你需要使用自定义配置，推荐直接从镜像里的 `config.example.php` 复制，避免手敲：

```bash
# 请先进入部署目录（示例：cd ~/siyuan-share）
docker create --name sps-config-tmp b8l8u8e8/siyuan-share-web:latest
docker cp sps-config-tmp:/var/www/html/config.example.php ./php-site/config.php
docker rm sps-config-tmp
```

然后重建容器并添加挂载：

```bash
# 请先进入部署目录（示例：cd ~/siyuan-share）
docker rm -f siyuan-share-web
docker run -d \
  --name siyuan-share-web \
  --restart unless-stopped \
  -p 38080:80 \
  -e TZ=Asia/Shanghai \
  -v "$(pwd)/php-site/storage:/var/www/html/storage" \
  -v "$(pwd)/php-site/uploads:/var/www/html/uploads" \
  -v "$(pwd)/php-site/config.php:/var/www/html/config.php:ro" \
  --health-cmd="curl -f http://localhost/ || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  --health-start-period=40s \
  b8l8u8e8/siyuan-share-web:latest
```

## 🔧 常用运维命令

查看容器状态：

```bash
docker ps -a --filter "name=siyuan-share-web"
```

查看最近日志：

```bash
docker logs --tail=200 siyuan-share-web
```

重启容器：

```bash
docker restart siyuan-share-web
```

停止容器：

```bash
docker stop siyuan-share-web
```

删除容器（不会删除主机挂载数据）：

```bash
docker rm -f siyuan-share-web
```

## 🔄 更新应用

```bash
# 请先进入部署目录（示例：cd ~/siyuan-share）
docker pull b8l8u8e8/siyuan-share-web:latest
docker rm -f siyuan-share-web
docker run -d \
  --name siyuan-share-web \
  --restart unless-stopped \
  -p 38080:80 \
  -e TZ=Asia/Shanghai \
  -v "$(pwd)/php-site/storage:/var/www/html/storage" \
  -v "$(pwd)/php-site/uploads:/var/www/html/uploads" \
  --health-cmd="curl -f http://localhost/ || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  --health-start-period=40s \
  b8l8u8e8/siyuan-share-web:latest
```

## 💾 数据备份与恢复

备份：

```bash
cd ~/siyuan-share
tar -czf backup-$(date +%Y%m%d).tar.gz \
  php-site/storage \
  php-site/uploads
```

如果你用了自定义 `config.php`，请把它也加入备份：

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
docker restart siyuan-share-web
```

## 🩺 故障排查

### 1) 镜像拉取失败

- 检查镜像名是否正确
- 检查服务器是否能访问 Docker Hub
- 测试命令：`docker pull b8l8u8e8/siyuan-share-web:latest`

### 2) 端口冲突

如果 `38080` 已占用，把启动命令里的 `-p 38080:80` 改成其他端口，例如 `-p 39180:80`。

### 3) 目录权限问题

```bash
sudo chown -R $(id -u):$(id -g) ~/siyuan-share/php-site/storage ~/siyuan-share/php-site/uploads
chmod -R 775 ~/siyuan-share/php-site/storage ~/siyuan-share/php-site/uploads
```

### 4) 健康检查异常

查看健康状态：

```bash
docker inspect siyuan-share-web --format '{{json .State.Health}}'
```

## ❗注意事项

1. 请务必备份 `php-site/storage`、`php-site/uploads`（若使用了 `config.php` 也要一并备份）。
2. 删除容器前确认已使用挂载目录保存数据。
3. 生产环境建议在前面加反向代理并配置 HTTPS。
