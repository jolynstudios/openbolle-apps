# Stap 1: TypeScript bouwen naar JavaScript
FROM node:22-alpine AS bouw
WORKDIR /bouw
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc

# Stap 2: alleen node en de gebouwde bestanden (geen npm, geen node_modules nodig)
FROM node:22-alpine
ENV NODE_ENV=production
# fetch() van Node gaat alleen met deze vlag via HTTPS_PROXY (de uitgang van het platform, netwerk:uitgaand)
ENV NODE_USE_ENV_PROXY=1
WORKDIR /app
COPY --from=bouw /bouw/package.json ./
COPY --from=bouw /bouw/dist ./dist
USER 65532:65532
EXPOSE 8080
CMD ["node", "dist/plugin.js"]
