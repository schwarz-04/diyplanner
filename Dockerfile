# Ein Image für alles: Editor (statisch), API und Blender (als Python-Modul bpy).
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.13-slim-bookworm
# Bibliotheken, die Blender headless braucht, plus ffmpeg für Videos
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libxrender1 libxi6 libxkbcommon0 libxxf86vm1 libxfixes3 libgl1 libegl1 libsm6 libice6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY shared/ shared/
COPY blender/ blender/
COPY backend/ backend/
COPY --from=web /web/dist web/dist
ENV DM_DATA_DIR=/data/projects PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
WORKDIR /srv/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
