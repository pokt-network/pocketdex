#!/bin/bash

. scripts/shared.sh

info_log "Removing all node_modules directories across the project and submodules..."

# Find all node_modules directories and delete them
find . -name "node_modules" -type d -prune -exec rm -rf '{}' +
find . -name "dist" -type d -prune -exec rm -rf '{}' +

info_log "All node_modules directories have been removed."
