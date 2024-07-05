#!/bin/sh

set -e

prepare_builder_layer() {
  if ! [ "$NODE_ENV" = "development" ]; then
    # if not development; call build, otherwise that will be achieve before nodemon start
    yarn run build
  else
    # create empty folder to prevent docker copy --from builder .. fail
    mkdir -p /app/dist
    touch /app/project.yaml
  fi
}

prepare_runner_layer() {
  if ! [ "$NODE_ENV" = "production" ]; then
    # install dev dependencies if not production
    yarn install
  else
    yarn install --prod
  fi
}

# Check command line argument
if [ "$1" = "builder" ]
then
    prepare_builder_layer
elif [ "$1" = "runner" ]
then
    prepare_runner_layer
else
    echo "Invalid argument! Please use 'builder' or 'runner'."
    exit 1
fi
