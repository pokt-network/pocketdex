#!/bin/sh

set -e

. scripts/shared.sh

info_log "generating exec params from env variables"
params=$(getParams)
info_log "generated params $params"

info_log "deleting previous project.yaml version"
rm /home/app/project.yaml
rm -rf /home/app/dist

NODE_ENV=$NODE_ENV yarn run build

info_log "updating project.yaml with env variables"
update_project

info_log "executing subql-node"
node ./vendor/subql-cosmos/packages/node/bin/run $params "$@"
