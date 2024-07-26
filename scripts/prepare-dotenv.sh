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
    # Create a copy of .env.sample for each environment
    cp .env.sample .env.$environment

    # Replace ENV= with ENV=<environment> in each file
    if [[ "$OSTYPE" == "darwin"* ]]; then
      # NB: sed works differently on macOS so we require that the user has gsed installed.
      # This is meant to fail and the expectation is that a user of this framework
      # will find this line / comment and install it.
      gsed -i "s/^ENV=.*$/ENV=$environment/g" .env.$environment
    else
      sed -i "s/^ENV=.*$/ENV=$environment/g" .env.$environment
    fi

  done
fi
