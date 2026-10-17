FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/Nirvana-Z777/opengym-mcp-bridge" \
      org.opencontainers.image.title="opengym-mcp-bridge" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json LICENSE ./
COPY src/ ./src/
RUN mkdir -p /secrets /store
ENV MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=3003
ENV OPENGYM_TOKEN_FILE=/secrets/opengym-token.json MCP_SECRET_FILE=/secrets/mcp-access-token
EXPOSE 3003
CMD ["node", "src/mcp.mjs"]
