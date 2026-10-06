FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY test-client ./test-client
COPY contract ./contract
COPY web ./web
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DB_FILE=/var/lib/cams-admin/cams-admin.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY contract ./contract
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ARG BUILD_DATE=
ENV BUILD_DATE=$BUILD_DATE
COPY CHANGELOG.md ./
RUN mkdir -p /var/lib/cams-admin && chown 1000:1000 /var/lib/cams-admin
# Numeric, not `USER node` (runAsNonRoot must be able to verify it).
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/server/server.js"]
