#!/bin/bash

. scripts/shared.sh

ENV=$1

source ".env.${ENV}"

info_log "NODE_ENV: $NODE_ENV - SCHEMA: $DB_SCHEMA - CHAIN: $CHAIN_ID - ENDPOINT: $ENDPOINT"

env NODE_ENV=$ENV CHAIN_ID=$CHAIN_ID ENDPOINT=$ENDPOINT ./scripts/build.sh

# this should publish with the right envs
yarn exec subql publish
