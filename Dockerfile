FROM node:22-slim
# claude の自動承認系フラグはroot不可のため非rootで実行
RUN useradd -m -s /bin/bash appuser
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY server.js ./
COPY public ./public
RUN mkdir -p /data/claude-config /data/specs && chown -R appuser:appuser /app /data
ENV CLAUDE_CONFIG_DIR=/data/claude-config
USER appuser
ENV PORT=8080 TZ=Asia/Tokyo
EXPOSE 8080
CMD ["node","server.js"]
