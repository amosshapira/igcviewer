# Build static binary
FROM docker.io/golang:1.26-alpine AS build

# FEATURE_FLUGBUECH=1 compiles in the flugbuech flight fetching integration
# (see cmd/server/flights_flugbuech.go)
ARG FEATURE_FLUGBUECH=1

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build $(if [ "${FEATURE_FLUGBUECH}" = "1" ]; then printf -- "-tags flugbuech"; fi) -trimpath -o /igcviewer ./cmd/server

# Runtime image: alpine keeps the image small and debuggable; CA
# certificates are needed when IGCVIEWER_UPSTREAM is an HTTPS URL. The
# upgrade pulls security fixes (e.g. zlib) that the base tag may predate.
FROM docker.io/alpine:3
RUN apk upgrade --no-cache \
 && apk add --no-cache ca-certificates
COPY --from=build /igcviewer /app/igcviewer

WORKDIR /app
EXPOSE 8080

# Configuration:
#   IGCVIEWER_ADDR        Address to listen on (default: localhost:8080)
#   IGCVIEWER_UPSTREAM    Base URL of the flugbuech API to fetch flights from
#   IGCVIEWER_TOKEN       Access token sent to the flugbuech API
ENTRYPOINT ["/app/igcviewer"]
