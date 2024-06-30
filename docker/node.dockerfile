FROM node:22-slim AS builder

ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll
ARG WATCH=false

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV WATCH=$WATCH

RUN apt-get update && apt-get install -y tree
RUN npm i -g typescript

# Copy the minimum required to run install and vendor:setup
# preventing this step need to be re-build everytime due to change on dev files
# but if for X reason you update a vendor package this step CACHE will be dropped
# by docker and fully rebuild
COPY package.json yarn.lock .yarnrc.yml /app/
COPY vendor /app/vendor
COPY .yarn /app/.yarn

WORKDIR /app

# Install dev dependencies
RUN yarn install

## Build forked vendor packages
RUN yarn run vendor:clean
RUN yarn run vendor:setup

# TODO_MAINNET(@jorgecuesta): Do a better use of copy to prevent copy everything which trigger a full build everytime.
# Copy files
COPY . /app

# Run codegen and Build pocketdex
RUN chmod +x scripts/prepare-docker-layers.sh && WATCH=$WATCH ./scripts/prepare-docker-layers.sh "builder"

FROM node:22-alpine as runner

# add group "app" and user "app"
RUN addgroup -g 1001 app && adduser -D -h /home/app -u 1001 -G app app

# Set arg and env on this layer again
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll
ARG WATCH=false

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV WATCH=$WATCH

# Add system dependencies
RUN apk update
RUN apk add git postgresql14-client tini curl jq

# TODO_MAINNET(@jorgecuesta): Add user and group instead of work with root to follow best practices.

# add extra tools that are required
ADD https://github.com/mikefarah/yq/releases/download/v4.26.1/yq_linux_amd64 /usr/local/bin/yq
RUN chmod +x /usr/local/bin/yq

# Switch to user "app"
WORKDIR /home/app

# add the dependencies
COPY ./package.json yarn.lock /home/app/

# include build artefacts in final image
COPY --from=builder /app/dist /home/app/dist
COPY --from=builder /app/vendor /home/app/vendor
COPY --from=builder /app/project.yaml /home/app/

# copy files from source not from builder
# NOTE: Docker documentation recommends the use of COPY for copying files and directories into an image because it's more transparent than ADD
COPY ./proto /home/app/proto
COPY ./scripts/shared.sh ./scripts/build.sh ./scripts/prepare-docker-layers.sh ./scripts/watch-exec.sh /home/app/scripts/
COPY ./project.ts schema.graphql nodemon.json tsconfig.json /home/app/
COPY ./scripts/node-entrypoint.sh /home/app/entrypoint.sh

# TODO_MAINNET(@bryanchriswhite): Add the .gmrc once migrations are available.
#COPY ./.gmrc /app/.gmrc

RUN chown app:app /home/app/entrypoint.sh && chmod +x /home/app/entrypoint.sh
RUN find /home/app/scripts -type f -name "*.sh" -exec chmod +x {} \;

# install production only or dev depending if WATCH is true
RUN WATCH=$WATCH ./scripts/prepare-docker-layers.sh "runner"

RUN mkdir -p /home/app/src/types && chown -R app:app /home/app/src/types

# this will be change inside of entrypoint.sh to been able to chown -R app:app the types mounted volume
# so the commands are finally running with app user
USER root

ENTRYPOINT ["/sbin/tini", "--", "/home/app/entrypoint.sh"]
