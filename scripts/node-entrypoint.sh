#!/bin/sh
set -e

. scripts/shared.sh

# prepare the env variables needed for subql node in a previous step to then based on WATCH env
# attach the rest of the command
# NOTE: this is needed because we exec the command with su - app which start a new session where the available
# env from root will not been available.
# all this is to been able to join WATCH and Normal execution in a single dockerfile
cmd="env NODE_OPTIONS=$NODE_OPTIONS \
NODE_ENV=$NODE_ENV \
CHAIN_ID=$CHAIN_ID \
BATCH_SIZE=$BATCH_SIZE \
START_BLOCK=$START_BLOCK \
DB_SCHEMA=$DB_SCHEMA"

if [ "$NODE_ENV" = "test" ]
then
  # this prevent all the not needed steps on the entrypoint when we want to run test inside container
  info_log "Running Tests only"
  params=$(get_params)
  scripts/build.sh no-lint
  cmd="$cmd node ./node_modules/@subql/node-cosmos/bin/run $params $@"
else
  # Add btree_gist extension to support historical mode - after the db reset from `graphile-migrate reset --erase`
  export PGPASSWORD=$DB_PASS

  psql -v ON_ERROR_STOP=1 \
    -h $DB_HOST \
    -U $DB_USER \
    -p $DB_PORT \
    -d $DB_DATABASE <<EOF
CREATE EXTENSION IF NOT EXISTS btree_gist;
EOF

  cmd="$cmd ENDPOINT=$ENDPOINT \
    DB_SCHEMA=$DB_SCHEMA \
    DB_USER=$DB_USER \
    DB_PASS=$DB_PASS \
    DB_DATABASE=$DB_DATABASE \
    DB_HOST=$DB_HOST \
    DB_PORT=$DB_PORT \
    POCKETDEX_DB_PAGE_LIMIT=$POCKETDEX_DB_PAGE_LIMIT \
    POCKETDEX_DB_BATCH_SIZE=$POCKETDEX_DB_BATCH_SIZE \
    POCKETDEX_DB_BULK_WRITE_CONCURRENCY=$POCKETDEX_DB_BULK_WRITE_CONCURRENCY"

  if [ "$NODE_ENV" = "development" ]
  then
    # call the first command if WATCH is true
    info_log "NODE_ENV is set to 'development'. Running with Hot-Reload..."

    exec="./scripts/watch-exec.sh $@"
    if ! jq --arg value "$exec" '. + {"exec": $value }' /app/nodemon.json > /tmp/temp.json; then
        error_log "Unable to inject exec command to nodemon.json" >&2
        exit 1
    fi

    mv /tmp/temp.json /app/nodemon.json

    cmd="$cmd yarn exec nodemon --config nodemon.json"
  else
    info_log "NODE_ENV is $NODE_ENV. Running the application without nodemon..."
    # move the dist folder to the mounted folder in run time
    update_project
    params=$(get_params)


    # run the main node
    cmd="$cmd node ./node_modules/@subql/node-cosmos/bin/run $params $@"
  fi
fi

# Sanitize and log the command before execution
sanitized_cmd=$(sanitize_cmd "$cmd")
info_log "Executing command: $sanitized_cmd"

eval $cmd
