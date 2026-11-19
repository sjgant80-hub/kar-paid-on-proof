# Kar trust layer — the whole spine in one container.
#   docker build -t kar-trust-layer .
#   docker run --rm kar-trust-layer                                  # local Shanghai EVM: no keys, no funds, no network
#   docker run --rm --env-file .env.aevum kar-trust-layer --network aevum   # QDay Aevum testnet with your TEST keys
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY artifacts ./artifacts
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY lib ./lib
COPY sdk ./sdk
COPY tools ./tools
COPY flow.mjs ./
# the audit trail is written to /app/runs; the image runs as the unprivileged node user
RUN mkdir -p /app/runs && chown node:node /app/runs
USER node
ENTRYPOINT ["node", "flow.mjs"]
CMD ["--network", "local"]
