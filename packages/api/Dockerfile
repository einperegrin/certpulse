FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm install --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY packages/api ./packages/api
RUN cd packages/api && npx tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/packages/api/dist ./dist
COPY --from=build /app/packages/api/package.json ./package.json
COPY --from=build /app/packages/api/src/db/migrations ./dist/db/migrations
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
