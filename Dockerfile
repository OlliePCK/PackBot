# PackBot — multi-stage build to a static binary on distroless.
#   docker build -t olliepck/packbot-go .

FROM golang:1.26 AS build

WORKDIR /src

# Cache module downloads separately from source changes. third_party must be
# present before `go mod download`: go.mod's replace directive points into it
# (locally patched disgolink — see third_party/disgolink/README.md).
COPY go.mod go.sum ./
COPY third_party/ third_party/
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/

# CGO_ENABLED=0 → fully static binary, safe on distroless/static.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /packbot ./cmd/packbot

# distroless/static ships CA certificates and tzdata (needed for Discord TLS
# and the Australia/Melbourne cron schedules) but no shell or libc.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /packbot /packbot

ENV TZ=Australia/Sydney

ENTRYPOINT ["/packbot"]
