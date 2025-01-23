# ---------
# Builder Stage
# ---------

FROM node:22.5-slim AS builder

ARG GENESIS_FILENAME=testnet.json
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID

# Typescript is added here because it is wrongly used on some workspaces, directly by name,
# without ensuring it's sourced from node_modules via npm/yarn exec or similar tools.
RUN apt-get update && apt-get install -y tree \
    # Required for building the Docker container on ARM64 (e.g., M1 chip).
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm i -g typescript

WORKDIR /app

# Copy only the minimal files to install dependencies and prepare vendor packages.
# This step is optimized to allow caching and prevent unnecessary rebuilds unless dependency changes occur.
COPY package.json yarn.lock .yarnrc.yml /app/
COPY scripts /app/scripts
COPY .yarn /app/.yarn

# Install dev dependencies (includes `typescript`, used for building and code generation).
RUN yarn install

# Copy all the relevant files for building the application.
COPY ./project.ts ./schema.graphql ./tsconfig.json ./.eslintrc.js ./.eslintignore /app/
COPY src /app/src
COPY proto /app/proto
COPY vendor /app/vendor
COPY genesis/${GENESIS_FILENAME} /app/genesis.json

# Build the application, generating output in the `dist` folder.
RUN yarn run build

# ---------
# Runner Stage
# ---------

FROM node:22.5-alpine AS runner

# Add group "app" and user "app".
RUN addgroup -g 1001 app && adduser -D -h /home/app -u 1001 -G app app

# Set the ARG and ENV variables in this stage as well.
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID

# Install runtime system dependencies.
RUN apk update
RUN apk add git postgresql14-client tini curl jq \
    # Required for ARM64 compatibility (e.g., building on an M1 chip).
    g++ make py3-pip

# Add a specific version of `yq` to avoid errors caused by different implementations/versions.
RUN curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq &&\
        chmod +x /usr/bin/yq

# Set the working directory.
WORKDIR /home/app

# Copy the minimal files again in this runner stage to start building both stages in parallel.
COPY package.json yarn.lock .yarnrc.yml /home/app/
COPY .yarn /home/app/.yarn
COPY scripts /home/app/scripts

# Install production dependencies.
# NOTE: If `yarn install` fails, add the `--inline-build` flag to make the logs more verbose, aiding in debugging.
RUN yarn install \
    # Use `yarn workspaces focus` to reduce dependencies to only production-level requirements.
    && yarn workspaces focus --production

# Copy the resolved `vendor` folder from the builder stage to the runner stage.
COPY --from=builder /app/vendor /home/app/vendor

# Copy application files and configs from the builder stage to the runner stage.
COPY --from=builder /app/project.ts /home/app/
COPY --from=builder /app/schema.graphql /home/app/
COPY --from=builder /app/tsconfig.json /home/app/

# Include the build artifacts in the final runner image.
COPY --from=builder /app/dist /home/app/dist
COPY --from=builder /app/project.yaml /home/app/
COPY --from=builder /app/proto /home/app/proto
COPY --from=builder /app/scripts /home/app/scripts

# Allow execution for every shell script in the `scripts` folder.
RUN find /home/app/scripts -type f -name "*.sh" -exec chmod +x {} \;

# Switch to the app user.
USER app

# Required after this version: https://github.com/subquery/subql-cosmos/releases/tag/node-cosmos/4.0.0
ENV TZ=utc

# Use `tini` as the entrypoint for better process handling.
ENTRYPOINT ["/sbin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]
