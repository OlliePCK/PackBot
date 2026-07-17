# PackBot (Go rewrite) — multi-stage build to a static binary on distroless.
# Built alongside the Node image (Dockerfile) during side-by-side cutover:
#   docker build -f go.Dockerfile -t olliepck/packbot-go .
# (Named go.Dockerfile, not Dockerfile.go — the Go toolchain would try to
# compile a *.go file at the module root.)

FROM golang:1.26 AS build

WORKDIR /src

# Cache module downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/
# Locally patched disgolink (see third_party/disgolink/README.md), wired via
# the replace directive in go.mod.
COPY third_party/ third_party/

# CGO_ENABLED=0 → fully static binary, safe on distroless/static.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /packbot ./cmd/packbot

# distroless/static ships CA certificates and tzdata (needed for Discord TLS
# and the Australia/Melbourne cron schedules) but no shell or libc.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /packbot /packbot

ENV TZ=Australia/Sydney

ENTRYPOINT ["/packbot"]
