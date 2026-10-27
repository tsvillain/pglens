# Self-host pglens on a server. Put a TLS reverse proxy (Caddy, nginx,
# Traefik) in front and set PGLENS_PUBLIC_URL to the subdomain it serves.
#   docker build -t pglens .
#   docker run -d -p 127.0.0.1:54321:54321 -v pglens-data:/home/node/.pglens \
#     -e PGLENS_PUBLIC_URL=https://db.example.com pglens
#   docker logs pglens   # prints the sign-in URL with the token

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN PGLENS_NO_POSTINSTALL=1 npm ci --omit=dev
COPY client-next/package.json client-next/package-lock.json client-next/
RUN npm --prefix client-next ci
COPY . .
RUN npm --prefix client-next run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PGLENS_BIND=0.0.0.0 \
    PGLENS_PORT=54321 \
    PGLENS_SECRET_STORE=file \
    PGLENS_NO_UPDATE_CHECK=1
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bin ./bin
COPY --from=build /app/src ./src
COPY --from=build /app/client-next/dist ./client-next/dist
RUN mkdir -p /home/node/.pglens && chown node:node /home/node/.pglens
USER node
VOLUME /home/node/.pglens
EXPOSE 54321
CMD ["node", "bin/pglens", "serve"]
