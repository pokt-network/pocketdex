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
env NODE_OPTIONS=$NODE_OPTIONS \
  POCKETDEX_DB_PAGE_LIMIT=$POCKETDEX_DB_PAGE_LIMIT \
  POCKETDEX_DB_BATCH_SIZE=$POCKETDEX_DB_BATCH_SIZE \
  POCKETDEX_DB_BULK_WRITE_CONCURRENCY=$POCKETDEX_DB_BULK_WRITE_CONCURRENCY \
  POCKETDEX_RECONCILE_VALIDATORS_EVERY_BLOCK=$POCKETDEX_RECONCILE_VALIDATORS_EVERY_BLOCK \
  POCKETDEX_RECONCILE_APPLICATIONS_EVERY_BLOCK=$POCKETDEX_RECONCILE_APPLICATIONS_EVERY_BLOCK \
  node ./node_modules/@subql/node-cosmos/bin/run $params "$@"
