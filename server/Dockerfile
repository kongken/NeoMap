# 构建上下文为 server/ 目录：docker build -t neomap-api server
FROM golang:1.27 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /out/neomap-api ./cmd/neomap-api

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/neomap-api /neomap-api
ENV BUTTERFLY_CONFIG_TYPE=file \
    BUTTERFLY_CONFIG_FILE_PATH=/etc/neomap/config.yaml \
    PORT=8080 \
    GIN_MODE=release
# 8080：HTTP / ConnectRPC；2223：Prometheus /metrics（Butterfly 内置）
EXPOSE 8080 2223
USER nonroot:nonroot
ENTRYPOINT ["/neomap-api"]
