# syntax=docker/dockerfile:1.7
# GraphQL API image: @subql/query 2.22.2 (the version pnf runs) on a patched Node.
# Built here instead of pulled from Docker Hub: no upstream subql-query image ships a patched Node, and
# subquerynetwork/subql-query:v2.25.0 (and latest) carries a backdoor in /dist/main.js (found 2026-10-22).
# The app comes from the npm tarball, pinned by checksum. yarn.lock is the one in subql-query:v2.22.2
# (sha256:036b5e28...), whose node_modules matched a --frozen-lockfile rebuild file by file.
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
# node 26 images ship no yarn; upstream's node 22 base had yarn 1.22.22. Pinned by checksum like the app.
ADD --checksum=sha256:c17d3797fb9a9115bf375e31bfd30058cac6bc9c3b8807a3d8cb2094794b51ca \
  https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz /yarn.tgz
RUN npm install -g /yarn.tgz && rm -rf /yarn.tgz /root/.npm
ADD --checksum=sha256:c5912c65ea743ade7ac6a0150c154afb9eaaac2589c8233edecf27eccbe421b9 \
  https://registry.npmjs.org/@subql/query/-/query-2.22.2.tgz /app.tgz
COPY yarn.lock /yarn.lock
RUN apk add --no-cache tini curl git && \
  tar -xzvf /app.tgz --strip 1 && \
  rm /app.tgz && \
  yarn install --production --frozen-lockfile && \
  yarn cache clean && \
  rm -rf /root/.npm /root/.cache
# Node 26 loads an extensionless file inside a "type":"module" package as ESM, even through require(). yargs 16.2.0
# ships its CJS entry as the extensionless file "yargs", so the API dies at startup. Same bytes as .cjs, export map
# pointed at it; it was the only such entry in node_modules.
RUN cp /node_modules/yargs/yargs /node_modules/yargs/yargs.cjs && \
  node -e 'const f="/node_modules/yargs/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));if(p.version!=="16.2.0")throw new Error(p.version);const e=p.exports["./yargs"];if(e[0].require!=="./yargs")throw new Error("unexpected exports");e[0].require="./yargs.cjs";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
USER 1000
ENTRYPOINT ["/sbin/tini", "--", "/bin/run"]
CMD ["-f", "/app"]
