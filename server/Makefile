# 常用开发命令（在 server/ 下执行）
.PHONY: build build-full release test test-short vet proto run docker

VERSION ?= dev
BUILD ?=

build:
	./scripts/fetch-geoip.sh
	go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o bin/openhane ./cmd/openhane

# 各平台的发布包（tar.gz / zip + SHA256SUMS），见 scripts/release.sh
release:
	VERSION=$(VERSION) ./scripts/release.sh

# 带网页版的完整二进制（不使用 Docker 部署时用）：先构建 Web 客户端并嵌入
build-full:
	cd ../clients/web && npm ci --no-audit --no-fund && HANE_VERSION=$(VERSION) HANE_BUILD=$(BUILD) npm run build
	find internal/webui/dist -mindepth 1 ! -name .gitignore ! -name .gitkeep -exec rm -rf {} +
	cp -R ../clients/web/apps/web/dist/. internal/webui/dist/
	$(MAKE) build

test:
	go test -race ./...

# 跳过需要启动内嵌 SFU 的端到端测试
test-short:
	go test -short ./...

vet:
	test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	go vet ./...
	./scripts/check-livekit-replace.sh

proto:
	../proto/generate.sh

# 本机运行：数据放在 ./data，日志为 debug
run:
	HANE_DATA_DIR=./data HANE_LOG_LEVEL=debug go run ./cmd/openhane

docker:
	cd .. && docker build -f server/Dockerfile --build-arg VERSION=$(VERSION) -t openhane/server:$(VERSION) .
