# Build the SPA, then serve the static bundle with the tiny zero-dep server.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Extracted from the roognis-product monorepo's web/ (originally served at
# /classroom behind Traefik alongside the vanilla frontend at /). This repo
# is standalone, so it now builds and serves at the root path.
ENV VITE_BASE=/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server.js package.json ./
EXPOSE 3000
CMD ["node", "server.js"]
