#!/bin/sh

. scripts/shared.sh

# Check if .env file exists
if [ ! -f .env ]; then
    error_log "No .env file found! Copy .env.sample; see README.md for more info." >&2
    exit 1
fi
