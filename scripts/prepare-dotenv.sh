#!/bin/sh

set -e

. scripts/shared.sh

# Check if .env.sample exists
if [ ! -f .env.sample ]; then
  warning_log ".env.sample does not exist. Skipping automatic dotenv files creation"
else
  # Define environments
  environments="development production test"

  for environment in $environments; do
    # Ensure the .env.$environment file doesn't already exist
    if [ -f .env.$environment ]; then
      warning_log ".env.$environment already exists. Skipping creation for this environment."
      continue
    fi

    # Create a copy of .env.sample for each environment
    cp .env.sample .env.$environment

    # Replace ENV= with ENV=<environment> in each file
    if [ "$(uname)" = "Darwin" ]; then
      # Mac OS X
      sed -i '' -e "s/^ENV=.*$/ENV=$environment/g" .env.$environment
    else
      # Linux and others
      sed -i'' -e "s/^ENV=.*$/ENV=$environment/g" .env.$environment
    fi
  done
fi
