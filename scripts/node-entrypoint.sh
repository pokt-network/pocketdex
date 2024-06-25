#!/bin/sh
set -e

# perform any updates that are required based on the environment variables
if [[ ! -z "${START_BLOCK}" ]]; then
    echo "[Config Update] Start Block: ${START_BLOCK}"
    yq -i '.dataSources[].startBlock = env(START_BLOCK)' project.yaml
fi

if [[ ! -z "${CHAIN_ID}" ]]; then
    echo "[Config Update] Chain ID: ${CHAIN_ID}"
    yq -i '.network.chainId = env(CHAIN_ID)' project.yaml
fi

if [[ ! -z "${NETWORK_ENDPOINT}" ]]; then
    echo "[Config Update] Network Endpoint: ${NETWORK_ENDPOINT}"
    yq -i '.network.endpoint = strenv(NETWORK_ENDPOINT)' project.yaml
fi

# Add btree_gist extension to support historical mode - after the db reset from `graphile-migrate reset --erase`
export PGPASSWORD=$DB_PASS
psql -v ON_ERROR_STOP=1 \
        -h $DB_HOST \
        -U $DB_USER \
        -p $DB_PORT \
        -d $DB_DATABASE <<EOF
CREATE EXTENSION IF NOT EXISTS btree_gist;
EOF

# run the main node
env node /vendor/subql-cosmos/packages/node/bin/run "$@"