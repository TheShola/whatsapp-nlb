FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
