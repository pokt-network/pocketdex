#!/bin/sh

set -e

. scripts/shared.sh

info_log "generating exec params from env variables"
params=$(get_params)
info_log "generated params $params"

info_log "updating project.yaml with env variables"
update_project

env NODE_ENV=$NODE_ENV yarn run watch:build

info_log "executing subql-node"
node ./node_modules/@subql/node-cosmos/bin/run $params "$@"
