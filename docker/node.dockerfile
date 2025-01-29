# Use the Node.js base image
FROM node:18.20.3-slim

# Set arguments and environment variables
ARG GENESIS_FILENAME=testnet.json
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV DOCKER_BUILD="true"
# Required after this version: https://github.com/subquery/subql-cosmos/releases/tag/node-cosmos/4.0.0
ENV TZ=utc

# Create and set up a non-root user for security
RUN addgroup --gid 1001 app && \
    useradd --create-home --uid 1001 --gid app app

# Set working directory
WORKDIR /home/app

# Install system dependencies and tools required for the build and runtime
RUN apt-get update && apt-get install -y \
    tree jq postgresql-client tini curl \
    # Required for building the Docker container on ARM64 (e.g., M1 chip).
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm install -g typescript \
    && curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq && \
    chmod +x /usr/bin/yq && \
    rm -rf /var/lib/apt/lists/*

# Copy the scripts folder, which includes install-vendor.sh
COPY scripts /home/app/scripts

# Allow execution for every shell script in the `scripts` folder.
RUN chmod +x /home/app/scripts/*.sh

# Copy only dependency-related files to maximize cache and avoid unnecessary rebuilds.
COPY package.json yarn.lock .yarnrc.yml vendor-builder.js vendor-config.yaml /home/app/
COPY .yarn /home/app/.yarn
# Install project dependencies
RUN yarn install

# ---------------------------------------------------------------------------------------------------------------------
# Vendor
# ---------------------------------------------------------------------------------------------------------------------

# Copy the vendor workspace folder
COPY vendor /home/app/vendor

RUN yarn run vendors:build

# Once they are build we do not really need them there because they are moved to node_modules with packaging.
RUN rm -rf /home/app/vendor

# ---------------------------------------------------------------------------------------------------------------------
# Pocketdex
# ---------------------------------------------------------------------------------------------------------------------

# Copy all the relevant files for building the application.
COPY ./project.ts ./schema.graphql ./tsconfig.json ./.eslintrc.js ./.eslintignore /home/app/
COPY src /home/app/src
COPY proto /home/app/proto
COPY genesis/${GENESIS_FILENAME} /home/app/genesis.json

# Build pocketdex
RUN yarn run build  \
    # Use `yarn workspaces focus` to reduce dependencies to only production-level requirements.
    && yarn dedupe --strategy highest \
    && yarn workspaces focus --production

# we do not need this at this point.
RUN rm -rf /home/app/src

# Switch to the non-root user created earlier
USER app

# Use `tini` as the entrypoint for better process handling
ENTRYPOINT ["/usr/bin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]
