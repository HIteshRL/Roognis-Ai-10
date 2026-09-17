FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache curl openssl
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate --schema=prisma/schema.prisma
EXPOSE 3005
CMD ["node", "server.js"]
