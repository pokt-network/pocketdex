#!/bin/sh

. scripts/shared.sh

env=$1

dot_env_file=$(get_env_file_name "$env")

# Check if .env file exists
if [ ! -f "$dot_env_file" ]; then
  error_log "No $dot_env_file file found! Copy .env.sample; see README.md for more info." >&2
  exit 1
fi

dockerfile="watch-node.dockerfile"
if [ "$env" = "production" ]; then
  dockerfile="node.dockerfile"
fi
