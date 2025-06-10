# Stage 1: Build Go binary
FROM golang:1.21 as builder
WORKDIR /app

# Cache go modules
# COPY ./bot/go.mod ./bot/go.sum ./
COPY ./bot/go.mod ./
RUN go mod download

# Copy source separately
COPY ./bot/*.go ./
RUN go build -o signalbot main.go

# Stage 2: Final image with Java + signal-cli
FROM eclipse-temurin:21-jdk as runtime

ARG SIGNAL_CLI_VERSION
ENV SIGNAL_CLI_VERSION=${SIGNAL_CLI_VERSION}

# Install system deps once, cacheable
RUN apt-get update && apt-get install -y \
  curl unzip jq git &&
  rm -rf /var/lib/apt/lists/*

# Install signal-cli once and symlink
RUN curl -fL -o /tmp/signal-cli.tar.gz \
  https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz &&
  mkdir -p /opt/signal-cli &&
  tar -xzf /tmp/signal-cli.tar.gz -C /opt &&
  ln -sf /opt/signal-cli /usr/local/bin/signal-cli

WORKDIR /app

# Copy Go binary only (source never enters final image)
COPY --from=builder /app/signalbot /app/signalbot
COPY ./bot/.env /app/.env

VOLUME ["/root/.local/share/signal-cli"]

CMD ["/app/signalbot"]
