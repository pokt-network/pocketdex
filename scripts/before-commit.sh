### Added this script to allow locally build both version for amd64 and arm64 as a way to test it locally what will
### be done on CI.

### IMPORTANT: you should have `buildx` properly configured on your host.
### https://github.com/docker/buildx

set -e

. scripts/shared.sh

info_log "Building development for AMD64"
docker buildx build -f docker/dev-node.dockerfile -t pocket-network/pocketdex:development-amd64 --platform=linux/amd64 .

info_log "Building development for ARM64"
docker buildx build -f docker/dev-node.dockerfile -t pocket-network/pocketdex:development-arm64 --platform=linux/arm64 .

info_log "Building production for AMD64"
docker buildx build -f docker/node.dockerfile -t pocket-network/pocketdex:development-amd64 --platform=linux/amd64 .

info_log "Building production for ARM64"
docker buildx build -f docker/node.dockerfile -t pocket-network/pocketdex:development-arm64 --platform=linux/arm64 .
