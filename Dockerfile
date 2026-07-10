FROM oven/bun:1.2.22-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["sh", "-c", "bun run db:migrate && exec bun run daemon"]
