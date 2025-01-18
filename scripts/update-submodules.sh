#!/bin/bash
set -e

# Initialize and update submodules
echo "Initializing and pulling submodules..."
git submodule update --init --recursive --remote

# Ensure correct branch is checked out for each submodule
echo "Checking out correct branches..."
git -C vendor/subql checkout feature/add-batch-and-conn-tunning
git -C vendor/subql-cosmos checkout enhance-events-handling-and-add-post-index-handler

echo "Submodules are successfully updated to the latest commit on their respective branches."
