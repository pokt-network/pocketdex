#!/bin/sh

set -e

### This script was made to avoid type all this commands on package.json script section for the script `docker:tunnel`

. scripts/shared.sh

service_name=proxy

wait_for_service() {
    service=$1
    max_retries=5
    retry=0

    while [ $retry -lt $max_retries ]; do
        status=$(docker compose ps -q $service)

        if [ ! -z "$status" ]; then
            info_log "Service '$service' is up"
            return 0
        else
            warning_log "Service '$service' is not up, retrying..."
            retry=$((retry+1))
            sleep 5
        fi
    done

    error_log "Service $service did not start after $max_retries attempts, exiting..."
    exit 1
}

info_log "Checking if poktroll validator is available at port 26657"
if ! nc -z localhost 26657 2>/dev/null; then
    error_log "Please validate that you have poktroll localnet validator up and listening on port 26657"
    exit 1
fi

info_log "Starting '$service_name' service"
docker compose up -d proxy

info_log "Checking if '$service_name' service is ready"
wait_for_service $service_name

info_log "Creating SSH tunnel to '$service_name' service"
warning_log 'NOTE: if public key auth fails the password is `proxypass`.'

ssh -o StrictHostKeyChecking=no -N -R 26657:localhost:26657 proxyuser@localhost -p 2222
if [ $? -ne 0 ]; then
  # this will not hurt anyone and prevent that if you use the docker compose down option the next time
  # your try to connect the target is a different one and will give you an error where instruct the user
  # to run the following command
  warning_log "Cleaning previous host and retrying..."
  ssh-keygen -f "$HOME/.ssh/known_hosts" -R "[localhost]:2222"
  ssh -o StrictHostKeyChecking=no -N -R 26657:localhost:26657 proxyuser@localhost -p 2222
  if [ $? -ne 0 ]; then
    error_log "Unable to open the tunnel with localhost:26657"
    exit 1
  fi
fi
