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

# 前端构建时注入版本号（页面底部显示），和运行阶段共用同一个 build arg
ARG VERSION=dev
ENV ADH_VERSION=${VERSION}

RUN pnpm --filter @adh/web build

# 只保留 @adh/server 的生产依赖（含 workspace 包与 scrcpy-server.jar）
RUN pnpm --filter @adh/server deploy --prod /out/server

# deploy 只保证依赖；源码、前端产物、package.json 显式补一份，避免不同 pnpm 版本行为差异
RUN mkdir -p /out/server/src /out/server/public \
  && cp -a apps/server/src/. /out/server/src/ \
  && cp -a apps/server/public/. /out/server/public/ \
  && cp apps/server/package.json /out/server/package.json

# 直连 APK：CI 先执行 gradlew assembleDebug，本地构建需先执行 pnpm portal:build。
# 放在 apps/server/portal/，与 portal-routes.ts 的 ../../portal/adh-portal.apk 对应。
RUN test -f apps/portal-android/app/build/outputs/apk/debug/app-debug.apk \
  || (echo "缺少直连 APK：请先执行 pnpm portal:build" >&2 && exit 1)
RUN mkdir -p /out/server/portal \
  && cp apps/portal-android/app/build/outputs/apk/debug/app-debug.apk \
        /out/server/portal/adh-portal.apk \
  && if [ -f apps/portal-android/app/build/outputs/apk/debug/output-metadata.json ]; then \
       cp apps/portal-android/app/build/outputs/apk/debug/output-metadata.json \
          /out/server/portal/output-metadata.json; \
     fi

# 构建期校验部署布局，路径不对就直接失败，不要等容器跑起来才报 MODULE_NOT_FOUND
RUN test -f /out/server/node_modules/tsx/dist/cli.mjs \
  && test -f /out/server/node_modules/@adh/protocol/src/index.ts \
  && test -f /out/server/node_modules/@adh/device-host/resources/scrcpy-server.jar \
  && test -f /out/server/src/index.ts \
  && test -f /out/server/public/index.html \
  && test -f /out/server/portal/adh-portal.apk


# 运行阶段
FROM node:22-bookworm-slim AS runtime

# 构建时传入版本号（CI 用 tag 名），启动日志会打印出来
ARG VERSION=dev

ENV NODE_ENV=production \
    ADH_VERSION=${VERSION} \
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

CMD ["node", "apps/server/node_modules/tsx/dist/cli.mjs", "apps/server/src/index.ts"]