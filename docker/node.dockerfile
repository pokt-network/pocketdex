FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y tree
RUN npm i -g typescript

WORKDIR /app

# Copy files
COPY . /app

# Add build dependencies
RUN yarn install # --frozen-lockfile

## Build forked vendor packages
RUN yarn run vendor:clean
RUN yarn run vendor:setup

# Build pocketdex
WORKDIR /app
RUN yarn codegen && yarn build

FROM node:22-alpine as runner

# Add system dependencies
RUN apk update
RUN apk add git postgresql14-client tini curl

# add extra tools that are required
ADD https://github.com/mikefarah/yq/releases/download/v4.26.1/yq_linux_amd64 /usr/local/bin/yq
RUN chmod +x /usr/local/bin/yq

WORKDIR /app

# add the dependencies
ADD ./package.json yarn.lock /app/
RUN yarn install --prod  # --frozen-lockfile

# include build artefacts in final image
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/vendor /vendor


ADD ./proto /app/proto
# TODO_MAINNET(@bryanchriswhite): Add the .gmrc once migrations are available.
#ADD ./.gmrc /app/.gmrc
ADD ./project.ts schema.graphql /app/
ADD ./scripts/node-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]