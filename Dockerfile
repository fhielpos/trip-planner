FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY node_modules ./node_modules

COPY server.js ./
COPY public ./public

# data directory will be mounted as a volume so trip.json persists
RUN mkdir -p /app/data

ARG COMMIT=unknown
ENV COMMIT=$COMMIT

EXPOSE 3000

CMD ["node", "server.js"]
