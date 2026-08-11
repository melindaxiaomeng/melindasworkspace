# 零依赖 Node 看板 —— 直接基于官方 Node 镜像，无需 npm install
FROM node:22-alpine

# 安装时区数据：node:22-alpine 默认无 tzdata，不装则 TZ 对 Node 的 Date 不生效，
# 定时报告（每天18:00）会按 UTC 触发（北京时间次日 2:00），偏差 8 小时。
RUN apk add --no-cache tzdata \
 && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

ENV TZ=Asia/Shanghai

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
