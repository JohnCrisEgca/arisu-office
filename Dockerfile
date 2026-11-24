FROM node:22-slim
WORKDIR /app
COPY package.json AGREEMENT.md ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data TRUST_PROXY=true
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
