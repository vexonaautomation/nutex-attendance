# One image runs both processes: `npm run start:api` (Fastify) and `npm run start:web` (Next.js). See docker-compose.yml.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages ./packages
# dev dependencies are needed on purpose: the API runs through tsx and the web build needs TypeScript
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build
USER node
EXPOSE 3000 4000
CMD ["npm", "run", "start:api"]
