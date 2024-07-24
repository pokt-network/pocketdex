FROM node:22.5-slim AS builder

ARG CI=false
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID

# Typescript is added here because is wrongly used on some of the workspaces, just by the name
# without the use of npm exec, yarn exec or any other to ensure they are looking into the node_modules
RUN apt-get update && apt-get install -y tree && npm i -g typescript

WORKDIR /app

# Copy the minimum required to run install and vendor:setup
# preventing this step need to be re-build everytime due to change on dev files
# but if for X reason you update a vendor package this step CACHE will be dropped
# by docker and fully rebuild
COPY package.json yarn.lock .yarnrc.yml /app/
COPY vendor /app/vendor
COPY scripts /app/scripts
COPY .yarn /app/.yarn

# Install dev dependencies
RUN yarn install

## Build forked vendor packages
RUN ./scripts/vendor.sh clean
RUN if [ "$CI" = "true" ]; then ./scripts/vendor.sh clean-cache; else echo "Not in CI"; fi
RUN ./scripts/vendor.sh setup

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
ARG CI=false

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV CI=$CI

# Add system dependencies
RUN apk update
RUN apk add git postgresql14-client tini curl jq yq

# Switch to user "app"
WORKDIR /home/app

# Copy same files from context to allow docker start building both layers in parallel
COPY package.json yarn.lock .yarnrc.yml /home/app/
COPY .yarn /home/app/.yarn
COPY scripts /home/app/scripts

# Install dependencies for production
# Starting from yarn 2.0, the --production flag is indeed deprecated.
# Yarn 2 introduced improvements to allow more precise installations.
RUN yarn workspaces focus --production

# Add the dependencies
COPY --from=builder /app/project.ts /app/schema.graphql /app/tsconfig.json /home/app/

# Include build artefacts in final image
COPY --from=builder /app/dist /home/app/dist
COPY --from=builder /app/vendor /home/app/vendor
COPY --from=builder /app/project.yaml /home/app/
COPY --from=builder /app/proto /home/app/proto
COPY --from=builder /app/scripts /home/app/scripts

# TODO_MAINNET(@bryanchriswhite): Add the .gmrc once migrations are available.
#COPY ./.gmrc /app/.gmrc

# Allow execution for every shell script at scripts folder
RUN find /home/app/scripts -type f -name "*.sh" -exec chmod +x {} \;

# Set user as app
USER app

ENTRYPOINT ["/sbin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]
