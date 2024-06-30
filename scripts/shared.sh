#!/bin/sh

set -e

warning_log() {
  echo -e "\033[1;33mWARN:\033[0m $1"
}

error_log() {
  echo -e "\033[1;31mERROR:\033[0m $1"
}

info_log() {
  echo -e "\033[1;32mINFO:\033[0m $1"
}

update_project() {
  if [ ! -f "project.yaml" ]; then
      return
  fi

  # perform any updates that are required based on the environment variables
  if [[ ! -z "${START_BLOCK}" ]]; then
      info_log "[Config Update] Start Block: ${START_BLOCK}"
      yq -i '.dataSources[].startBlock = env(START_BLOCK)' project.yaml
  fi

  if [[ ! -z "${CHAIN_ID}" ]]; then
      info_log "[Config Update] Chain ID: ${CHAIN_ID}"
      yq -i '.network.chainId = env(CHAIN_ID)' project.yaml
  fi

  if [[ ! -z "${ENDPOINT}" ]]; then
      info_log "[Config Update] Network Endpoint: ${ENDPOINT}"
      yq -i '.network.endpoint = strenv(ENDPOINT)' project.yaml
  fi
}

getParams() {
    local params=""

    if [[ -n "$WORKERS" ]]; then
        params="--workers=$WORKERS"
    fi
    if [[ -n "$BATCH_SIZE" ]]; then
        params="${params} --batch-size=$BATCH_SIZE"
    fi
    if [[ -n "$DB_SCHEMA" ]]; then
        params="${params} --db-schema=$DB_SCHEMA"
    fi
    echo "$params"
}
