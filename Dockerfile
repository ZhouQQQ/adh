# 构建阶段：装全量依赖并产出前端 + 生产依赖
FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# pnpm 由 corepack 按 package.json 的 packageManager 安装
RUN corepack enable \
  && corepack prepare pnpm@9.11.0 --activate

# 先拷依赖清单，代码没变时可复用 install 缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/device-host/package.json packages/device-host/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @adh/web build

# 只保留 @adh/server 的生产依赖（含 workspace 包与 scrcpy-server.jar）
RUN pnpm --filter @adh/server deploy --prod /out/server


# 运行阶段
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ADH_HOST=0.0.0.0 \
    ADH_PORT=8080 \
    ADH_DATA_DIR=/data \
    ADH_LOCAL_AGENT=0

WORKDIR /app

# 保持 apps/server 层级：config.ts 用 ../../ 推导仓库根
COPY --from=build /out/server ./apps/server

RUN mkdir -p /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=(process.env.ADH_BASE_PATH||'').split('/').filter(Boolean).join('/');fetch('http://127.0.0.1:8080'+(p?'/'+p:'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]