#!/bin/sh

set -e

. scripts/shared.sh

info_log "generating exec params from env variables"
params=$(get_params)
info_log "generated params $params"

env NODE_ENV=$NODE_ENV yarn run watch:build

info_log "updating project.yaml with env variables"
update_project

info_log "executing subql-node"
NODE_OPTIONS=$NODE_OPTIONS node ./node_modules/@subql/node-cosmos/bin/run $params "$@"
