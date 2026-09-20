# Build from source inside the image.
#
# This used to be `COPY dist ./dist` against a `dist/` committed to git, which
# made the deployment artifact something a human had to remember to regenerate.
# Forgetting was silent: the deploy went green and production kept serving the
# previous build. That is exactly how the admin chat-oversight routes shipped
# their source but not their compiled output.
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

# No lockfile is committed (see .gitignore), so `npm ci` is not available.
COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
# `tsc && tsc-alias` — tsc-alias rewrites the `@/…` paths to relative requires,
# which plain `node dist/index.js` cannot resolve on its own.
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /usr/src/app/dist ./dist

CMD ["node", "dist/index.js"]
