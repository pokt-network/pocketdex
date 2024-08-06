FROM node:22.5-slim AS builder

ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID

# Typescript is added here because is wrongly used on some of the workspaces, just by the name
# without the use of npm exec, yarn exec or any other to ensure they are looking into the node_modules
RUN apt-get update && apt-get install -y tree \
    # The following was necessary to install in order to add support for building
    # the docker container on an M1 chip (i.e. ARM64)
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm i -g typescript

WORKDIR /app

# Copy the minimum required to run install and vendor:setup
# preventing this step need to be re-build everytime due to change on dev files
# but if for X reason you update a vendor package this step CACHE will be dropped
# by docker and fully rebuild
COPY package.json yarn.lock .yarnrc.yml /app/
COPY scripts /app/scripts
COPY .yarn /app/.yarn

# Install dev dependencies
RUN yarn install

# Copy files
COPY ./project.ts ./schema.graphql ./tsconfig.json ./.eslintrc.js ./.eslintignore /app/
COPY src /app/src
COPY proto /app/proto

# Run codegen and Build pocketdex
RUN yarn run build

FROM node:22.5-alpine AS runner

# add group "app" and user "app"
RUN addgroup -g 1001 app && adduser -D -h /home/app -u 1001 -G app app

# Set arg and env on this layer again
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID

# Add system dependencies
RUN apk update
RUN apk add git postgresql14-client tini curl jq
# The following was necessary to install in order to add support for building
# the docker container on an M1 chip (i.e. ARM64)
RUN apk add g++ make py3-pip
# add specific version of yq because depending on the operative system it could get another implementation or version
# than produce error on shell scripts later.
RUN curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq &&\
        chmod +x /usr/bin/yq

# Switch to user "app"
WORKDIR /home/app

# Copy same files from context to allow docker start building both layers in parallel
COPY package.json yarn.lock .yarnrc.yml /home/app/
COPY .yarn /home/app/.yarn
COPY scripts /home/app/scripts

# Install dependencies for production
# NOTE: in case a yarn install fail, please add --inline-build to produce a more verbose installation logs, that could
# help you debugging what is going wrong.
RUN yarn install \
    # Starting from yarn 2.0, the --production flag is indeed deprecated.
    # Yarn 2 introduced improvements to allow more precise installations.
    # The install now is needed because there are some dependencies that need to be build and that is achieve on install \
    # the with this command the dependencies are reduced to only leave production one.
    && yarn workspaces focus --production

# Add the dependencies
COPY --from=builder /app/project.ts /app/schema.graphql /app/tsconfig.json /home/app/

# Include build artefacts in final image
COPY --from=builder /app/dist /home/app/dist
COPY --from=builder /app/project.yaml /home/app/
COPY --from=builder /app/proto /home/app/proto
COPY --from=builder /app/scripts /home/app/scripts

# Allow execution for every shell script at scripts folder
RUN find /home/app/scripts -type f -name "*.sh" -exec chmod +x {} \;

# Set user as app
USER app
# Required after this version https://github.com/subquery/subql-cosmos/releases/tag/node-cosmos/4.0.0
ENV TZ=utc

ENTRYPOINT ["/sbin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]
