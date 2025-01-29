#!/bin/bash

. scripts/shared.sh

# Check if DOCKER_IMAGE is set to "true"
if [ "$DOCKER_BUILD" = "true" ]; then
  info_log "Skipping script execution: DOCKER_IMAGE is set to 'true'."
  exit 0
fi


# Initialize and update submodules
info_log "Initializing and pulling submodules..."
git submodule update --init --recursive --remote

# Ensure correct branch is checked out for each submodule
info_log "Checking out correct branches..."
git -C vendor/subql checkout feature/add-batch-and-conn-tunning
git -C vendor/subql-cosmos checkout enhance-events-handling-and-add-post-index-handler
git -C vendor/cosmjs checkout feature/add-module-accounts

info_log "Submodules are successfully updated to the latest commit on their respective branches."
