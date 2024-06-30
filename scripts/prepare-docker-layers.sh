#!/bin/sh

set -e

echo "@watch=$WATCH"

prepare_builder_layer() {
  if ! [ "$WATCH" = "true" ]
  then
    # if not watch; then call build, otherwise that will be achieve before nodemon start
    yarn run build
  else
    # create empty folder to prevent docker copy --from builder .. fail
    mkdir -p /app/dist
    touch /app/project.yaml
  fi
}

prepare_runner_layer() {
  if [ "$WATCH" = "true" ]
  then
    # install dependencies
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
