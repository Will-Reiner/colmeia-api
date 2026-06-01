FROM node:20-alpine

# better-sqlite3 e um modulo nativo: precisa de toolchain para compilar/rebuildar
# na arquitetura do container. Instalamos as deps de build, e podemos remove-las
# depois para manter a imagem enxuta.
RUN apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app

# Copia manifestos primeiro para aproveitar o cache de camadas.
COPY package*.json ./

# Instala apenas dependencias de producao (sem devDependencies).
RUN npm ci --omit=dev \
    && apk del .build-deps

# Copia o restante do codigo.
COPY . .

# Diretorio do volume persistente do SQLite.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/colmeia.db

EXPOSE 3000

# Healthcheck: o orquestrador (Coolify) usa isto para saber se o app esta vivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;require('http').get('http://127.0.0.1:'+p+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
