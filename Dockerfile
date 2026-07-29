# Etapa 1: Compilación de Next.js
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Etapa 2: Imagen de producción ligera
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copiamos dependencias y configuramos entorno
COPY package*.json ./
COPY patches ./patches
# tsx y concurrently van en dependencies, por lo que se instalarán aquí
RUN npm ci --omit=dev

# Copiamos los binarios construidos y los archivos necesarios
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000
CMD ["npm", "run", "start:all"]
