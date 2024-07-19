#!/bin/sh

set -e

. scripts/shared.sh


# Check if any argument is provided
if [ $# -eq 0 ]
then
    error_log "No arguments supplied"
    exit 1
fi

# no mater the environment we need to ensure the external network for the proxy is up
NETWORK_NAME="localnet_proxy"

# Check if the network exists
if [ "$(docker network ls | grep $NETWORK_NAME)" ]; then
    info_log "Network $NETWORK_NAME exists."
else
    info_log "Network $NETWORK_NAME does not exist, creating..."
    docker network create $NETWORK_NAME
fi

# The first argument is your replacement string.
env=$1

# Shift the parameters so we could pass the rest to docker compose
shift

# Check the existence of dotenv file
scripts/dotenv-check.sh "$env"

# Call docker-compose with all remaining parameters
docker compose -f "docker-compose.$env.yml" --env-file ".env.$env" --project-name "pocketdex_$env" "$@"
