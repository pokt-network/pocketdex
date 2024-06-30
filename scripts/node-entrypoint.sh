#!/bin/sh
set -e

. scripts/shared.sh

# Add btree_gist extension to support historical mode - after the db reset from `graphile-migrate reset --erase`
export PGPASSWORD=$DB_PASS
psql -v ON_ERROR_STOP=1 \
        -h $DB_HOST \
        -U $DB_USER \
        -p $DB_PORT \
        -d $DB_DATABASE <<EOF
CREATE EXTENSION IF NOT EXISTS btree_gist;
EOF

# ensure that ignore_types mounted path got assigned to app user, otherwise get EACCES: permission denied
# this is only need on WATCH=true because is regenerated after any change detected.
chown -R app:app /home/app/proto
chown -R app:app /home/app/src
chown -R app:app /home/app/dist
chown app:app /home/app/project.yaml
chown app:app /home/app/project.ts
chown app:app /home/app/schema.graphql

# prepare the env variables needed for subql node in a previous step to then based on WATCH env
# attach the rest of the command
# NOTE: this is needed because we exec the command with su - app which start a new session where the available
# env from root will not been available.
# all this is to been able to join WATCH and Normal execution in a single dockerfile
cmd="env NODE_ENV=$NODE_ENV \
CHAIN_ID=$CHAIN_ID \
ENDPOINT=$ENDPOINT \
DB_USER=$DB_USER \
DB_PASS=$DB_PASS \
DB_DATABASE=$DB_DATABASE \
DB_HOST=$DB_HOST \
DB_PORT=$DB_PORT"

if [ "$WATCH" = "true" ]
then
  # call the first command if WATCH is true
  info_log "WATCH is true. Installing nodemon and Running with it..."
  if [ "$NODE_ENV" = "production" ]
  then
      # Add commands to do something here
      warning_log "Hot-reload is not recommended in production. Unset $WATCH to disable it."
  fi

  exec="./scripts/watch-exec.sh $@"
  if ! jq --arg value "$exec" '. + {"exec": $value }' nodemon.json > temp.json; then
      error_log "Unable to inject exec command to nodemon.json" >&2
      exit 1
  fi
  mv temp.json nodemon.json

  cmd="$cmd yarn exec nodemon --config nodemon.json"

else
  # call the other command if WATCH is not true
  info_log "WATCH is not true. Running the application without nodemon..."
  # move the dist folder to the mounted folder in run time
  update_project
  params=$(getParams)

  # run the main node
  cmd="$cmd node /home/app/vendor/subql-cosmos/packages/node/bin/run $params $@"
fi

exec su - app -s /bin/sh -c "$cmd"
