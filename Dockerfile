FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY live-demo/package*.json live-demo/
COPY live-demo/scripts live-demo/scripts
RUN npm ci --prefix live-demo
COPY frontend/package*.json frontend/
RUN npm ci --prefix frontend
COPY live-demo live-demo
COPY frontend frontend
RUN npm --prefix frontend run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r backend/requirements.txt
COPY --from=build /app/frontend frontend
COPY backend backend
COPY .openai .openai
COPY deploy/start.py deploy/start.py
RUN mkdir -p /app/backend/data && chown -R node:node /app
USER node
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 EDGESENSE_API_URL=http://127.0.0.1:8001
EXPOSE 10000
CMD ["/opt/venv/bin/python", "deploy/start.py"]
