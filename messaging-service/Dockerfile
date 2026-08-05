# ────────────────────────────────────────────────────────────
# Etapa 1: dependencias + build
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Herramientas de compilación necesarias para módulos nativos:
# sharp, bcrypt, bufferutil, utf-8-validate. Sin esto, `pnpm install`
# falla al intentar compilar sus bindings de C++ sobre Alpine (musl).
RUN apk add --no-cache python3 make g++ vips-dev

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm prisma generate
RUN pnpm build

# Poda las devDependencies del node_modules ya compilado, dejando solo
# lo necesario para producción. Se hace AQUÍ, en el builder (donde sí
# están las herramientas de compilación), no reinstalando desde cero en
# la etapa final — eso reventaría con los mismos módulos nativos.
RUN pnpm prune --prod

# ────────────────────────────────────────────────────────────
# Etapa 2: imagen de producción, mínima
# ────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# vips es la librería de sistema que sharp necesita en RUNTIME
# (no solo al compilar) — sin esto, sharp compila bien pero falla
# al cargarse la primera vez que se usa.
RUN apk add --no-cache vips

RUN corepack enable && corepack prepare pnpm@latest --activate

# node_modules ya compilado y podado, tal cual salió del builder —
# no se vuelve a instalar nada aquí.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

RUN addgroup -S conduit && adduser -S conduit -G conduit
USER conduit

EXPOSE 4123

CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main"]