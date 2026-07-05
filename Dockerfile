FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# opencode CLI (npm package chính thức)
RUN npm install -g opencode-ai

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=6666 ADMIN_PORT=6667
EXPOSE 6666 6667 4096

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
CMD ["/docker-entrypoint.sh"]
