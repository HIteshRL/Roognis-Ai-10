# Build the SPA, then serve the static bundle with the tiny zero-dep server.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# In the roognis-product monorepo this was served behind Traefik at
# /classroom alongside the vanilla frontend at /. This standalone repo has
# no sibling frontend, so it is built and served at /. Adjust VITE_BASE if
# you deploy it behind a path prefix again.
ENV VITE_BASE=/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server.js package.json ./
EXPOSE 3000
CMD ["node", "server.js"]
