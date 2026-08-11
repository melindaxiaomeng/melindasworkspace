# 零依赖 Node 看板 —— 直接基于官方 Node 镜像，无需 npm install
FROM node:22-alpine

WORKDIR /app

# 仅复制运行所需文件（data/ 由挂载卷提供，不打包进镜像）
COPY package.json ./
COPY server.js ./
COPY public ./public

# 确保数据目录存在；若运行时挂载了持久卷，此目录即卷挂载点
RUN mkdir -p /app/data \
 && chown -R node:node /app

# 以非 root 用户运行，缩小容器逃逸后的影响面
USER node

# 容器平台（Northflank / Oracle / 任意 Docker 主机）注入 PORT；默认 3000 兜底
EXPOSE 3000

CMD ["node", "server.js"]
