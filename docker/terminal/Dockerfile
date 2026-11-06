FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache \
    bash \
    ca-certificates \
    coreutils \
    curl \
    ffmpeg \
    findutils \
    gawk \
    git \
    github-cli \
    jq \
    nodejs \
    npm \
    python3 \
    py3-pip \
    ripgrep \
    sed

ENV HOME=/tmp \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8

WORKDIR /workspace
USER 1000:1000
