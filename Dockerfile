# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Stage 1: build ubersdr-packet Go binary
# ---------------------------------------------------------------------------
FROM golang:1.24-bookworm AS go-builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o /out/ubersdr-packet ./...

# ---------------------------------------------------------------------------
# Stage 2: minimal runtime image
# Use ubuntu:24.04 to match the Qt/ALSA library versions that QtSoundModem
# was compiled against (same base as ka9q_ubersdr).
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# Install Qt5/Qt6 and other runtime libraries required by QtSoundModem,
# matching the package set used in the ka9q_ubersdr Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        libqt5core5t64 \
        libqt5gui5t64 \
        libqt5widgets5t64 \
        libqt5network5t64 \
        libqt5multimedia5 \
        libqt5serialport5 \
        libqt6core6t64 \
        libqt6network6t64 \
        libasound2t64 \
        libsamplerate0 \
        libcurl4t64 \
        libfftw3-single3 \
    && rm -rf /var/lib/apt/lists/*

# Download the correct QtSoundModem binary for the target architecture.
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
        wget -q https://github.com/madpsy/ka9q_ubersdr/releases/download/latest/piQtSoundModem64 \
             -O /usr/local/bin/QtSoundModem; \
    else \
        wget -q https://github.com/madpsy/ka9q_ubersdr/releases/download/latest/QtSoundModem64 \
             -O /usr/local/bin/QtSoundModem; \
    fi \
    && chmod +x /usr/local/bin/QtSoundModem

COPY --from=go-builder /out/ubersdr-packet /usr/local/bin/ubersdr-packet
COPY static/ /app/static/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data \
    && useradd -r -s /bin/false packet \
    && chown packet:packet /data

USER packet

WORKDIR /app

VOLUME ["/data"]

EXPOSE 6096

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/bin/wget", "-q", "-O", "/dev/null", "http://localhost:6096/"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
