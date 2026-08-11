# 增量上线 / 更新部署（阿里云 ECS）

适用：本地改完 `server.js`、`public/index.html`（或 `data/` 外任意文件）后，把改动同步到 ECS 上的 `workspace.teensing.com`。

> 前置：已完成首次部署（容器 `kanban-pool` 在跑、数据卷 `kanban-data` 挂 `/app/data`、nginx 反代已配）。

## 一、本地 Mac：传改动文件到 ECS

只传改过的文件，别传整个目录（会覆盖 ECS 上的 `.env`，里面存着 `API_TOKEN`）。

```bash
# 改了后端
scp /Users/menlinda.meng/Desktop/ai/Personal_workflow/kanban-pool/server.js \
    root@47.76.101.39:/opt/kanban-pool/server.js

# 改了前端（本次 + 之前所有前端改动都在这一个文件）
scp /Users/menlinda.meng/Desktop/ai/Personal_workflow/kanban-pool/public/index.html \
    root@47.76.101.39:/opt/kanban-pool/public/index.html
```

> `root@` 改成你 ECS 实际 SSH 登录名；若用密钥别名/非 root，相应调整主机部分。
> 以后若还改了 `Dockerfile` / `docker-compose.yml` / `.env`，记得也一并 scp 对应文件。

## 二、登录 ECS：重新构建镜像 + 强制重建容器

```bash
ssh root@47.76.101.39
cd /opt/kanban-pool

# 1) 重新构建镜像（--no-cache 是 build 子命令参数，旧版 Compose 的 up 不认这个 flag）
docker compose -f deploy/aliyun/docker-compose.yml --env-file deploy/aliyun/.env build --no-cache

# 2) 强制用新镜像重建并起容器（关键：--force-recreate，否则容器仍跑旧镜像 = "没生效"）
docker compose -f deploy/aliyun/docker-compose.yml --env-file deploy/aliyun/.env up -d --force-recreate
```

> 若你的 Compose 版本支持 `up --build`，可合成一条：
> `docker compose -f deploy/aliyun/docker-compose.yml --env-file deploy/aliyun/.env up -d --build --force-recreate`

## 三、验证

```bash
sleep 5
docker compose -f deploy/aliyun/docker-compose.yml ps
curl -s http://127.0.0.1:3777/api/config; echo
```

按当次改动，在线上确认新前端节点（把 `f-xxx` 换成当次新增的弹窗/筛选项 id）：

```bash
# 容器内是否含新节点（证明新镜像进了容器）
docker exec kanban-pool grep -c 'f-images' /app/public/index.html
# 线上是否含新节点（0 则 Cloudflare/浏览器缓存，硬刷新或清 CDN 缓存）
curl -s https://workspace.teensing.com/ | grep -c 'f-images'
```

## 四、"没生效"排查三段式

```bash
echo -n "宿主机: "; grep -c 'f-images' /opt/kanban-pool/public/index.html
echo -n "容器内: "; docker exec kanban-pool grep -c 'f-images' /app/public/index.html
echo -n "线上:   "; curl -s https://workspace.teensing.com/ | grep -c 'f-images'
```

- **宿主 = 0** → scp 没传对路径，重传 `public/index.html` 到 `/opt/kanban-pool/public/index.html`。
- **宿主 > 0，容器 = 0** → 容器没重建，用第二步的 `--force-recreate` 重来。
- **宿主 = 容器 > 0，线上 = 0** → Cloudflare / 浏览器缓存：浏览器硬刷新（Cmd+Shift+R）；还不行去 Cloudflare 开 Development Mode 或清缓存。

## 五、整体同步（大改时）

用 `rsync` 排除 `.env` 和 `data`，把本地整目录推进 ECS：

```bash
rsync -av --exclude='data' --exclude='.env' --exclude='.git' --exclude='node_modules' \
  /Users/menlinda.meng/Desktop/ai/Personal_workflow/kanban-pool/ \
  root@47.76.101.39:/opt/kanban-pool/
```

传完同样执行第二步（build --no-cache + up -d --force-recreate）。

## 注意事项

- **数据不丢**：条目、笔记、上传的图片都在持久卷 `kanban-data`（挂 `/app/data`，含 `items.json` / `notes.json` / `uploads/`），重建镜像/容器不影响。
- **改后端必须 build**：`server.js` 跑在容器里，光 `up -d` 不重建镜像则新代码不生效。
- **改前端也要 build**：`index.html` 是被 `COPY` 进镜像的，必须重新 build（加 `--no-cache` 防旧文件层命中缓存）。

## 六、AI 功能（异常诊断 / 自动摘要）上线说明

AI 模块可选、靠环境变量开启，不破坏零依赖基调：

- ECS 的 `deploy/aliyun/.env` 里加 `AI_API_KEY`（DeepSeek key）。**不设则看板自动隐藏 AI 功能**（`/api/config` 返回 `aiEnabled:false`）。
- 想更强语义检索，在 `.env` 加 `AI_EMBED_BASE_URL` / `AI_EMBED_MODEL` / `AI_EMBED_API_KEY`（如 SiliconFlow 的 `BAAI/bge-m3`）。**留空则用本地 TF-IDF 兜底**，无需任何额外服务。
- `AI_MOCK=1` 仅本地调试用，线上务必设 `0`。

上线后验证 AI 接口真正进容器：

```bash
echo -n "容器内 aiEnabled: "; docker exec kanban-pool curl -s http://127.0.0.1:3000/api/config | grep -o 'aiEnabled":[a-z]*'
# 期望 true（已配 AI_API_KEY）
```

前端改动含 AI 按钮与诊断渲染，确认线上 `index.html` 含 `aiDiagnose` / `aiSummaryBtn`。
