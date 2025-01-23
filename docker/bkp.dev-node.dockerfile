FROM node:22.5-slim

ARG CI=false
ARG NODE_ENV=development
ARG ENDPOINT
ARG CHAIN_ID=poktroll
ARG GENESIS_FILENAME

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV CI=$CI

# Typescript is added here because it is incorrectly used in some workspaces
# directly by the name, without using `npm exec`, `yarn exec`, or other methods
# to ensure `typescript` is sourced from `node_modules`.
RUN apt-get update \
    && apt-get install -y tree git postgresql-client tini curl jq \
    # The following was necessary to install in order to add support for building
    # the docker container on an M1 chip (i.e., ARM64).
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm i -g typescript

# Add a specific version of `yq` because different implementations or versions,
# depending on the operating system, can cause errors later in shell scripts.
RUN curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq &&\
            chmod +x /usr/bin/yq

WORKDIR /app

# -------------------------------------------
# Dependencies step: Handles main and vendor
# -------------------------------------------
# Copy only dependency-related files to maximize cache and avoid unnecessary rebuilds.
COPY package.json yarn.lock .yarnrc.yml /app/
COPY .yarn /app/.yarn

# Explicitly add vendor files to the image.
# These files are assumed to be prepared in the `vendor/` directory of the repo.
# This ensures everything needed from submodules is baked into the image at build time.
COPY vendor /app/vendor

# Install project dependencies (including vendor files).
RUN yarn install
# Install vendor dependencies
RUN yarn install:vendor
# Build vendor modules
RUN yarn build:vendor

# -------------------------------------------
# Source code step: Separate for better caching
# -------------------------------------------
# Copy genesis file.
COPY ./genesis/${GENESIS_FILENAME} /app/genesis.json

# Copy remaining project sources for local dev, as `nodemon` will enable file watching.
COPY . /app

# Required after this version: https://github.com/subquery/subql-cosmos/releases/tag/node-cosmos/4.0.0
ENV TZ=utc

# Allow execution for every shell script in the `scripts` folder.
RUN find /app/scripts -type f -name "*.sh" -exec chmod +x {} \;

ENTRYPOINT ["tini", "--", "/app/scripts/node-entrypoint.sh"]
