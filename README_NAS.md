# NAS 部署指南

## 问题说明

NAS 上使用 bind mount (直接挂载主机目录) 可能会遇到权限问题,因为:
- NAS 通常使用 NFS、CIFS/SMB 等网络文件系统
- 这些文件系统不完全支持 Unix 权限管理
- `chown` 命令可能失败或被忽略

## 解决方案:使用 Docker Named Volumes

### 1. 使用 NAS 专用配置文件

```bash
# 在 NAS 上使用这个配置文件
docker-compose -f docker-compose.nas.yml up -d
```

### 2. 配置说明

`docker-compose.nas.yml` 使用 named volumes 而不是 bind mounts:

```yaml
volumes:
  - storage-data:/var/www/html/storage   # Docker 管理的 volume
  - uploads-data:/var/www/html/uploads   # Docker 管理的 volume
```

**优点**:
- ✅ Docker 自动管理权限
- ✅ 兼容所有 NAS 文件系统
- ✅ 性能更好
- ✅ 数据持久化

**缺点**:
- ❌ 数据不直接在主机目录中可见
- ❌ 需要使用 Docker 命令查看/备份

### 3. 数据管理

#### 查看数据位置

```bash
docker volume ls
docker volume inspect siyuan-plugin-share_storage-data
```

#### 查看数据内容

```bash
# 查看 storage 数据
docker run --rm -v siyuan-plugin-share_storage-data:/data alpine ls -lah /data

# 查看数据库
docker run --rm -v siyuan-plugin-share_storage-data:/data alpine cat /data/app.db | wc -c
```

#### 备份数据

```bash
# 使用提供的备份脚本
./backup-volumes.sh
```

手动备份:
```bash
# 备份 storage
docker run --rm \
  -v siyuan-plugin-share_storage-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/storage-$(date +%Y%m%d).tar.gz -C /source .

# 备份 uploads  
docker run --rm \
  -v siyuan-plugin-share_uploads-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/uploads-$(date +%Y%m%d).tar.gz -C /source .
```

#### 恢复数据

```bash
# 恢复 storage
docker run --rm \
  -v siyuan-plugin-share_storage-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cd /target && tar xzf /backup/storage-20260114.tar.gz"

# 恢复 uploads
docker run --rm \
  -v siyuan-plugin-share_uploads-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cd /target && tar xzf /backup/uploads-20260114.tar.gz"
```

### 4. 迁移现有数据 (如果有)

如果你之前使用 bind mount 并且已有数据:

```bash
# 1. 停止服务
docker-compose down

# 2. 备份现有数据
cp -r php-site/storage backups/storage-old
cp -r php-site/uploads backups/uploads-old

# 3. 使用新配置启动
docker-compose -f docker-compose.nas.yml up -d

# 4. 复制数据到 volume
docker run --rm \
  -v siyuan-plugin-share_storage-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cp -r /backup/storage-old/* /target/"

docker run --rm \
  -v siyuan-plugin-share_uploads-data:/target \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cp -r /backup/uploads-old/* /target/"

# 5. 重启服务
docker-compose -f docker-compose.nas.yml restart
```

### 5. 定期备份设置

在 NAS 上设置定时任务:

**群晖 NAS**:
1. 控制面板 → 任务计划
2. 新增 → 自定义脚本
3. 设置每天运行
4. 脚本内容: `cd /volume1/docker/siyuan-plugin-share && ./backup-volumes.sh`

**QNAP**:
1. 控制台 → 系统 → 排程
2. 添加任务
3. 脚本: `cd /share/Container/siyuan-plugin-share && ./backup-volumes.sh`

## 快速部署步骤

```bash
# 1. 从仓库拉取源码。如果不使用 Git，也可以直接下载仓库的压缩包，解压后放到当前目录，效果是一样的。
git clone https://github.com/b8l8u8e8/siyuan-plugin-share.git

# 2. 准备配置文件(必须复制)
cd siyuan-plugin-share
cp php-site/config.example.php php-site/config.php

# 3. 使用 NAS 配置启动
docker-compose -f docker-compose.nas.yml up -d

# 4. 可选：查看日志
docker-compose -f docker-compose.nas.yml logs -f

# 5. 打开浏览器并访问
#http://your-nas-ip:8080

# 6. 初始账号密码
#管理员账号密码默认为admin/123456 登录后尽快修改密码
```

## 更新应用

更新前建议先备份（见“数据管理”里的备份脚本/命令），避免意外。

### 更新仓库代码后重启容器

```bash
# 1. 使用 Git 拉取最新源码；
# 如果不使用 Git，也可以直接下载仓库的最新压缩包，解压后覆盖当前目录中的源码。
#
# 如果拉取时提示冲突（conflict），说明：
# 你本地修改过的文件，刚好也在云端被更新了。
# 为了防止你的修改被直接覆盖，Git 会要求你先确认如何处理。
#
# 这是正常现象，不是报错。
# 根据提示处理完成后，再次执行 git pull 即可。
git pull

# 2. 重新构建镜像并启动容器（named volumes 会保留数据）
docker-compose -f docker-compose.nas.yml up -d --build

# 3. 可选：查看日志
docker-compose -f docker-compose.nas.yml logs -f
```

> 说明：使用 named volumes（storage-data / uploads-data）时，更新不会影响已有数据。

## 故障排查

### 如果还是有权限问题

先按下面步骤排查：

```bash
# 1) 查看容器日志
docker-compose -f docker-compose.nas.yml logs --tail=200 web

# 2) 进入容器检查目录是否可写
docker-compose -f docker-compose.nas.yml exec web sh -lc "id && ls -ld /var/www/html/storage /var/www/html/uploads"
docker-compose -f docker-compose.nas.yml exec web sh -lc "touch /var/www/html/storage/.rw && rm /var/www/html/storage/.rw && echo storage-ok"
docker-compose -f docker-compose.nas.yml exec web sh -lc "touch /var/www/html/uploads/.rw && rm /var/www/html/uploads/.rw && echo uploads-ok"

# 3) 确认 volume 挂载状态
docker volume inspect siyuan-plugin-share_storage-data
docker volume inspect siyuan-plugin-share_uploads-data
```

如果仍有问题，建议先备份后重建 volume 再恢复数据。

### 检查 Docker 版本

```bash
docker --version
docker-compose --version
```

确保 Docker 版本 >= 20.10

### 查看 volume 驱动

```bash
docker volume inspect siyuan-plugin-share_storage-data | grep Driver
```

应该显示 `"Driver": "local"`
