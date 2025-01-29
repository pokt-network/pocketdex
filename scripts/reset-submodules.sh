#!/bin/bash

. scripts/shared.sh

# List of directories
directories=(vendor/subql vendor/subql-cosmos vendor/cosmjs)

# Iterate over the directories and execute the commands
for dir in "${directories[@]}"; do
  info_log "Restoring $dir submodule..."
  git -C "$dir" reset --hard
  git -C "$dir" clean -nfd --no-dry
done
