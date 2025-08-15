# syntax=docker/dockerfile:1

# 1) Install prod deps
FROM node:20-alpine AS deps

# Install netcat for health checks
RUN apk add --no-cache netcat-openbsd

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# 2) Runtime image
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the app
COPY . .

# Default port (override with -e PORT=xxxx)
ENV PORT=3001
EXPOSE 3001

# Start the WS server
CMD ["node", "server/server.js"]
