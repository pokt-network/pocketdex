#!/bin/sh

set -e

# Note: The proxy service is only necessary if you're running a Shannon
# localnet and are unable to use the docker network in bridge mode.
# To use the proxy service, you must run the following command on the host
# to establish a reverse proxy such that docker services in the composition
# will be able to port forward to the localnet services exposed on the host:

. scripts/shared.sh

IMAGE_NAME="pocket-network/pocketdex-proxy:latest"
SERVICE_NAME="proxy"
NETWORK_NAME="localnet_proxy"

exit_error(){
  error_log "No argument supplied, please provide an argument: start, stop"
  exit 1
}

check_argument() {
  if [ -z "$1" ]; then
    exit_error
  fi
}

wait_for_service() {
    max_retries=5
    retry=0

    info_log "Checking if poktroll validator is available at port 26657"
    while [ $retry -lt $max_retries ]; do
        status=$(docker ps -q -f name="$SERVICE_NAME")

        if [ ! -z "$status" ]; then
            info_log "Service '$SERVICE_NAME' is up"
            return 0
        else
            warning_log "Service '$SERVICE_NAME' is not up, retrying..."
            retry=$((retry+1))
            sleep 5
        fi
    done

    error_log "Service $SERVICE_NAME did not start after $max_retries attempts, exiting..."
    exit 1
}

ensure_network() {
  # Check if the network exists
  if [ "$(docker network ls | grep $NETWORK_NAME)" ]; then
      info_log "Network $NETWORK_NAME exists."
  else
      info_log "Network $NETWORK_NAME does not exist, creating..."
      docker network create $NETWORK_NAME
  fi
}

check_docker_image() {
  info_log "Checking if $IMAGE_NAME image exists"
  # Check if the Docker image exists
  if [ "$(docker images -q $IMAGE_NAME)" ]; then
      info_log "Proxy Image $IMAGE_NAME exists."
  else
      info_log "Proxy Image $IMAGE_NAME does not exist, building it..."
      docker build -t "$IMAGE_NAME" -f ./docker/proxy.dockerfile .
  fi
}

start_service() {
  info_log "Starting '$SERVICE_NAME' service"
  docker run -d -p 2222:22 --name="$SERVICE_NAME" \
    --network=$NETWORK_NAME \
    -v ~/.ssh/id_rsa.pub:/home/proxyuser/.ssh/authorized_keys \
    -e USER_NAME=proxyuser \
    -e USER_PASSWORD=proxypass \
    "$IMAGE_NAME" > /dev/null 2>&1
  info_log "Proxy service started"
}

start() {
  if ! nc -z localhost 26657 2>/dev/null; then
      error_log "Please validate that you have poktroll localnet validator up and listening on port 26657"
      exit 1
  fi

  check_docker_image
  ensure_network

  stop # just to be sure it does not exists before try to start a new one.
  start_service
  wait_for_service

  info_log "Cleaning up previous known_hosts to this proxy"
  ssh-keygen -f "$HOME/.ssh/known_hosts" -R "[localhost]:2222" > /dev/null 2>&1

  info_log "Creating SSH tunnel to '$SERVICE_NAME' service"
  warning_log 'NOTE: if public key auth fails the password is `proxypass`.'

  ssh -o StrictHostKeyChecking=no -N -R 26657:localhost:26657 proxyuser@localhost -p 2222
  if [ $? -ne 0 ]; then
    # this will not hurt anyone and prevent that if you use the docker compose down option the next time
    # your try to connect the target is a different one and will give you an error where instruct the user
    # to run the following command
    warning_log "Cleaning previous host and retrying..."
    ssh-keygen -f "$HOME/.ssh/known_hosts" -R "[localhost]:2222" > /dev/null 2>&1
    ssh -o StrictHostKeyChecking=no -N -R 26657:localhost:26657 proxyuser@localhost -p 2222
    if [ $? -ne 0 ]; then
      error_log "Unable to open the tunnel with localhost:26657"
      exit 1
    fi
  fi
}

stop() {
  # check if the container is running
  if [ "$(docker ps -a -q -f name=$SERVICE_NAME)" ]; then
    info_log "Stopping and removing service $SERVICE_NAME..."

    # stop the container
    docker stop "$SERVICE_NAME" > /dev/null 2>&1

    # remove the container
    docker rm "$SERVICE_NAME" > /dev/null 2>&1

    info_log "Service $SERVICE_NAME has been stopped and removed."
  else
    error_log "No running service found with name $SERVICE_NAME."
  fi
}

check_argument "$1"

if [ "$1" = "start" ]; then
  start
elif [ "$1" = "stop" ]; then
  stop
else
  exit_error
fi
