#!/bin/sh

. scripts/shared.sh

dot_env_file=$(get_env_file_name "$1")

# Check if .env file exists
if [ ! -f "$dot_env_file" ]; then
  error_log "No $dot_env_file file found! Copy .env.sample; see README.md for more info." >&2
  exit 1
fi
