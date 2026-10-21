# 羽见服务端镜像。在仓库根目录构建：
#   docker build -f server/Dockerfile -t openhane/server .
# 最终镜像为 distroless static：没有 shell。容器以 root 启动，程序先把数据目录交给
# PUID / PGID（默认 65532），再降为该用户运行服务（见 internal/privdrop），绑定挂载属于 root 的宿主机目录也能直接使用。
# 依赖下载单独成层，改代码时不会重新下载。
# Web 客户端在 node 阶段构建，产物嵌入服务端二进制。
# 网页版的 AI 降噪（WASM + 模型）需要先在构建上下文里生成：clients/deepfilter/build.sh web（CI 和发布流程会做；没有时镜像照常构建，只是不带 AI 降噪）。
# 多平台构建（buildx --platform linux/amd64,linux/arm64）时，网页版和 Go 编译都在构建机的原生架构上执行，
# Go 交叉编译出目标架构，避免在 QEMU 模拟下编译。需要 BuildKit（Docker 23 起默认）。
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /src/clients/web
COPY clients/web/ ./
ARG VERSION=dev
ARG BUILD=
RUN npm ci --no-audit --no-fund && HANE_VERSION=${VERSION} HANE_BUILD=${BUILD} npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
# IPv4 归属地库单独成层（只在脚本里的版本变化时重新下载）
COPY server/scripts/fetch-geoip.sh scripts/
RUN mkdir -p internal/geoip/data && ./scripts/fetch-geoip.sh
COPY server/ ./
COPY --from=web /src/clients/web/apps/web/dist/ internal/webui/dist/
ARG VERSION=dev
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/openhane ./cmd/openhane \
 && mkdir -p /out/data

FROM gcr.io/distroless/static
COPY --from=server /out/openhane /openhane
COPY --from=server --chown=65532:65532 /out/data /data
ENV HANE_DATA_DIR=/data PUID=65532 PGID=65532
VOLUME ["/data"]
EXPOSE 9800/tcp 9800/udp 9801/tcp
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["/openhane", "healthcheck"]
ENTRYPOINT ["/openhane"]
CMD ["serve"]
