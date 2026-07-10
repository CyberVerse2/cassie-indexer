FROM oven/bun:1.3.4-alpine AS runtime

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["sh", "-c", "bun run db:migrate && bun run seed && exec bun run daemon"]
