#!/bin/sh

set -e

. scripts/shared.sh

exit_error(){
  error_log "No argument supplied, please provide an argument: setup, clean-cache, clean"
  exit 1
}

check_argument() {
  if [ -z "$1" ]; then
    exit_error
  fi
}

vendor_setup_cosmjs() {
  info_log "Running Install on vendor cosmjs"
  yarn workspace cosmjs-monorepo-root install
  yarn workspace cosmjs-monorepo-root run build
}

vendor_setup_subql() {
  info_log "Running Install on vendor subql"
  yarn workspace @subql/node-cosmos install
  yarn workspace @subql/node-cosmos run build
}

vendor_clean() {
  info_log 'Cleaning `node_modules` and `dist` folders recursively on vendor modules'
  find . -name node_modules | xargs rm -rf && find . -name dist | xargs rm -rf
}

vendor_clean_cache() {
  info_log 'Installing and Building vendor modules'
  yarn cache clean --all && cd cosmjs && yarn cache clean --all
}

vendor_setup() {
  vendor_setup_cosmjs
  vendor_setup_subql
}

check_argument "$1"

cd vendor

if [ "$1" = "setup" ]; then
  vendor_setup
elif [ "$1" = "clean-cache" ]; then
  vendor_clean_cache
elif [ "$1" = "clean" ]; then
  vendor_clean
fi

cd ..
