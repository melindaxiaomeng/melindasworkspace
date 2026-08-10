# 部署到 Northflank（免费档）

适用场景：个人「需求与问题池」看板，零依赖 Node 服务 + JSON 文件持久化。
Northflank 免费档：2 个服务（各 0.2 vCPU / 512MB）、常驻不休眠、支持持久卷。注册需验证信用卡但不扣费（超额才收，最低付费档 $2.70/月）。

> 关键点：**必须挂持久卷到 `/app/data`**，否则 `data/items.json` 在每次重新部署后会被清空。

---

## 0. 准备（本地）

本目录已是完整应用（含 `Dockerfile`）。确保这些文件在 Git 仓库根目录：
- `server.js`
- `package.json`
- `public/index.html`
- `Dockerfile`
- `.dockerignore`

## 1. 推到 GitHub

```bash
cd kanban-pool
git init
git add .
git commit -m "kanban-pool: 需求与问题池看板"
# 在 github.com/new 建一个空仓库，拿到 URL 后：
git remote add origin https://github.com/<你的用户名>/kanban-pool.git
git branch -M main
git push -u origin main
```

## 2. 注册 Northflank

1. 打开 https://northflank.com → Sign up。
2. 验证信用卡（仅验证，不扣费）。
3. 新建一个 **Project**（选 Northflank Cloud，区域选离你近的，如 `us-east-1` / `eu-west-1`）。

## 3. 创建服务（从 GitHub）

在 Project 内：
1. **Services → Create service → Combined service**。
2. 连接 GitHub，选 `kanban-pool` 仓库与 `main` 分支。
3. **Build options → Dockerfile**（平台会自动在仓库根找到 `Dockerfile`）。
4. **Networking → Add port**：
   - 类型 `Public`
   - 内部端口 `3000`（与 `Dockerfile` 的 `EXPOSE 3000` 一致）
   - 协议 `HTTP`
   - 平台会自动分配一个 `*.code.run` 的 HTTPS 地址。

## 4. 配置环境变量（Environment）

在服务的 **Environment** 里添加：

| Key | Value | 说明 |
|---|---|---|
| `API_TOKEN` | 一长串随机串（如 `openssl rand -hex 24` 生成） | **必填**。这就是登录密码；不设则任何人可读写 |
| `HOST` | `0.0.0.0` | 已写进代码默认值，可不设；显式写更稳 |

> 注意：免费档是「运行时变量」，直接加到 Environment 即可，无需 build args。

## 5. 挂持久卷（关键！）

在服务的侧边栏 **Volumes → Add volume**：
- 名称：`data`
- 挂载路径：**`/app/data`**（必须与此一致，应用把 `items.json` 写在这里）
- 大小：免费档给的量即可（1–2 GB 绰绰有余）

挂上后，重新部署一次，数据就会落在持久卷上，重部署/重启不再丢失。

## 6. 部署 & 验证

1. 保存后平台会自动构建并部署（也可手动 Trigger deploy）。
2. 打开分配的 `https://<服务名>.code.run`。
3. 出现登录页 → 输入 `API_TOKEN` 的值登录。
4. 点「+ 新增条目」试一条，刷新页面确认还在 → 持久化 OK。

## 7. 维护

- **改 API_TOKEN**：在 Environment 改值 → Redeploy；前端用新令牌重新登录。
- **备份数据**：Northflank 卷可创建快照；或临时进容器 `kubectl`/Web terminal 拷 `data/items.json`。
- **自定义域名**：Project 内 Add domain，按提示加 DNS CNAME 即可（免费档支持）。
- **免费档限制**：2 个服务、各 512MB；我们的看板单实例远够用。超出免费额度才计费。

## 排错

- **连不上 / 一直加载**：确认 `HOST=0.0.0.0`（已默认）且服务监听 `PORT`（代码已处理 `process.env.PORT || 3000`）。
- **数据每次都没了**：没挂卷。回去第 5 步把卷挂到 `/app/data`。
- **401 登录失败**：`API_TOKEN` 前后端不一致；确认 Environment 里的值与登录框输入一致。
