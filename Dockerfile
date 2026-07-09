FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# data directory will be mounted as a volume so trip.json persists
RUN mkdir -p /app/data

# Content hash of the served app files, baked in at build time. sw.js keys
# its cache on COMMIT (see server.js's /sw.js route) so the service worker
# only re-installs and clears old assets when this changes — without it,
# a `docker compose up --build` that has no git history / no --build-arg
# always produces the same "unknown" COMMIT and the browser keeps serving
# stale cached JS forever even though the image was rebuilt.
RUN find server.js public -type f | sort | xargs cat | sha1sum | cut -c1-12 > /app/.build-id

ARG COMMIT
ENV COMMIT=$COMMIT
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
