# One image for every service. `api`, `worker`, `migrate`, `seed` and `test` differ only in the
# command compose gives them, so building five images would mean five copies of the same
# node_modules and five chances for them to drift apart.
FROM node:22-bookworm-slim

WORKDIR /app

# Prisma's engines need OpenSSL, and the slim image does not ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifests first, so a source-only change does not invalidate the dependency layer. The schema
# comes with them because `npm ci` runs prisma's postinstall generate.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json jest.config.js ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

# Not compiled: the same image has to run the Jest suite, which needs the TypeScript sources.
# ts-node costs a few seconds of startup and buys one image instead of two.
CMD ["node", "--version"]
