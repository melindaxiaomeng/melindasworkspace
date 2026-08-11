# 部署到阿里云 ECS（需求与问题池看板）

> 优势：国内服务器，延迟远低于 Northflank（美国）。代码已推到 GitHub（`melindaxiaomeng/melindasworkspace`），但本手册优先用 **scp 直传**，不依赖 GitHub、也更私密。

---

## 0. 前提

- 一台阿里云 ECS（Linux，1 vCPU / 1GB 内存足够，系统盘 20GB+）
- 已拿到 **公网 IP**
- ⚠️ **安全组必须放通端口**（最容易忘的一步）：
  - 控制台 → 实例 → 安全组 → 配置规则 → 入方向 → 添加：
    - 若走 Docker 直出 3000：放行 **TCP 3000**（源 `0.0.0.0/0`，或只放你自己的 IP 更稳）
    - 若走 nginx + HTTPS：放行 **TCP 80 / 443**
- 本地已装 `scp`/`ssh`（Mac 自带）

---

## ★ 共享 nginx 速通（你的场景，照抄即可）

> 前提：服务器已有 nginx 在跑其他项目、且有域名。看板只绑本机 `127.0.0.1:3777`，由现有 nginx 反代，安全组只需 80/443（应已开）。

**① 本地把代码传到 ECS**
```bash
scp -r /Users/menlinda.meng/Desktop/ai/Personal_workflow/kanban-pool root@<ECS公网IP>:/opt/kanban-pool
```

**② ECS 上装 Docker（若已有可跳过）**
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

**③ 配令牌并启动容器**
```bash
cd /opt/kanban-pool/deploy/aliyun
cp .env.example .env && nano .env        # API_TOKEN 填 openssl rand -hex 24 生成的串
cd /opt/kanban-pool
docker-compose -f deploy/aliyun/docker-compose.yml --env-file deploy/aliyun/.env up -d --build
docker logs -f kanban-pool               # 看到 "已启动" 即成功
```

**④ 接到现有 nginx（改一处即可）**
```bash
sudo cp /opt/kanban-pool/deploy/aliyun/nginx-host-snippet.conf /etc/nginx/conf.d/kanban-pool.conf
sudo nano /etc/nginx/conf.d/kanban-pool.conf   # 已预填 workspace.teensing.com；HTTPS 段打开并改证书路径即可
sudo nginx -t && sudo systemctl reload nginx
```
- 访问：`http://你的子域名`（建议再把片段里 HTTPS 段打开，复用你其他项目的证书路径）
- 数据在 Docker 卷 `kanban-data`，重建容器不丢

---

## 方案 A：Docker 部署（推荐，最省心、可移植）

### A1. 本地装 Docker（在 ECS 上执行）

```bash
# 通用一键装（Alibaba Cloud Linux / CentOS / Ubuntu 都行）
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER      # 退出重登后免 sudo
# 装 compose 插件
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/bin/docker-compose && sudo chmod +x /usr/local/bin/docker-compose
```

### A2. 把代码传到 ECS（在本地 Mac 执行）

```bash
# 从项目根目录传整个 kanban-pool/
scp -r /Users/menlinda.meng/Desktop/ai/Personal_workflow/kanban-pool \
      root@<ECS公网IP>:/opt/kanban-pool
```
> 备选：若仓库公开，也可在 ECS 上 `git clone https://github.com/melindaxiaomeng/melindasworkspace.git /opt/kanban-pool`

### A3. 配置令牌并启动（在 ECS 上执行）

```bash
cd /opt/kanban-pool/deploy/aliyun
cp .env.example .env
# 编辑 .env，把 API_TOKEN 换成强随机串：
#   API_TOKEN=$(openssl rand -hex 24)
nano .env
# 回到项目根用 compose 启动
cd /opt/kanban-pool
docker-compose -f deploy/aliyun/docker-compose.yml --env-file deploy/aliyun/.env up -d --build
```

- 数据落在 Docker 卷 `kanban-data` → 容器内 `/app/data`，**重启/重建容器不丢**
- 查看日志：`docker logs -f kanban-pool`
- 应用只监听本机 `127.0.0.1:3777`，**不直接暴露公网**；由服务器现有 nginx 反代进来：
  - 把 `deploy/aliyun/nginx-host-snippet.conf` 复制到 `/etc/nginx/conf.d/kanban-pool.conf`，改 `server_name` 为你的域名，`nginx -t && systemctl reload nginx`
  - 访问：`http://pool.yourdomain.com`（或你配的子域名）→ 用 `API_TOKEN` 登录
  - 若暂时没有 nginx/域名，可临时把 compose 里 `127.0.0.1:3777:3000` 改成 `3777:3000` 并放通安全组 3777 直连（不推荐长期使用）

> **共用服务器隔离三道锁**：① 容器独立文件系统/进程树，碰不到别的项目的文件；② 专属端口 `3777` + 仅绑本机，不与其他项目抢端口、不直连公网；③ `memory 256M / cpus 0.5` 资源上限，抢不走别的项目的资源。

---

## 方案 B：原生 systemd + nginx（不用 Docker）

> 复用仓库里已有的 `deploy/kanban-pool.service` 与 `deploy/nginx/kanban-pool.conf`。

### B1. 在 ECS 上装 Node 18+

```bash
# Alibaba Cloud Linux / CentOS
sudo dnf -y install nodejs
# 或 Ubuntu
# sudo apt-get update && sudo apt-get install -y nodejs
node -v   # 需 >= 18
```

### B2. 传代码 + 起服务

```bash
scp -r /Users/menlinda.meng/Desktop/ai/Personal_workflow/kanban-pool root@<ECS公网IP>:/opt/kanban-pool
ssh root@<ECS公网IP>
cd /opt/kanban-pool
# 写入令牌（即登录密码）
echo 'API_TOKEN=$(openssl rand -hex 24)' | sudo tee /etc/kanban-pool.env
sudo chmod 600 /etc/kanban-pool.env
# 放 systemd 单元
sudo cp deploy/kanban-pool.service /etc/systemd/system/
# 编辑 service：确认 node 路径（which node）、User、EnvironmentFile 指向 /etc/kanban-pool.env
sudo systemctl daemon-reload
sudo systemctl enable --now kanban-pool
```

应用只监听 `127.0.0.1:3000`，再由 nginx 反代（见下）。

---

## HTTPS（可选但建议，避免令牌明文传输）

### 用阿里云免费证书

1. 控制台 → **SSL 证书** → 购买/领取 **免费 DV 证书**（绑定你的域名，如 `pool.yourdomain.com`）
2. 下载 **Nginx 格式** 证书，传到 ECS：`/etc/nginx/certs/`
3. 改 `deploy/nginx/kanban-pool.conf`：把 `server_name` 换成你的域名，启用 80→443 跳转与 ssl 段（文件里已留注释模板）
4. 安全组放通 80/443，重载 nginx：`sudo nginx -t && sudo systemctl reload nginx`

> 无域名也可跳过 HTTPS，直接 `http://<公网IP>:3000`，但令牌为明文，建议仅自己 IP 放通 3000。

---

## 运维速查

| 操作 | 命令 |
|---|---|
| 看日志 | `docker logs -f kanban-pool`（A） / `journalctl -u kanban-pool -f`（B） |
| 改令牌 | 改 `.env` 或 `/etc/kanban-pool.env` 后重启容器/服务 |
| 备份数据 | 拷 `data/items.json`（B）或 `docker volume inspect kanban-data` 找到宿主机路径（A） |
| 升级 | 重传代码 → `docker-compose ... up -d --build`（A） / `systemctl restart kanban-pool`（B） |
| 关停 | `docker-compose ... down`（A） / `systemctl stop kanban-pool`（B） |
