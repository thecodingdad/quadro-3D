# QUADRO 3D with backend: app and API from one origin.
#
#   docker compose up                            ->  ready-made image from GHCR
#   docker compose -f compose.dev.yml up --build ->  from this source tree
#
# The app then lives at http://localhost:8000/web/index.html.
#
# Data is kept in the volume under /data (see compose.yml). Without a volume,
# saved models are gone on the next start.

FROM python:3.12-slim

# Version of the app. The release workflow passes the number from the tag in
# here; images built by hand are called "dev". The server reads its own number
# from the VERSION file -- this label is only for the registry.
ARG VERSION=dev

LABEL org.opencontainers.image.title="QUADRO 3D" \
      org.opencontainers.image.description="Planning tool for QUADRO climbing frames: build, parts list, QDF import and export." \
      org.opencontainers.image.source="https://github.com/thecodingdad/quadro-3D" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app

# Dependencies first: that keeps the layer cached as long as requirements.txt
# does not change.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Do not run as root. /data belongs to the user `app` -- a NAMED volume adopts
# these permissions when it is first created. A bind mount brings its own and
# needs a one-off `chown 1000:1000` on the host.
RUN useradd --uid 1000 --create-home app \
    && mkdir -p /data \
    && chown app:app /data
USER app

ENV QUADRO_DATA=/data \
    QUADRO_PORT=8000
EXPOSE 8000

# No curl in the slim image -- the standard library is enough.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health').read()"]

CMD ["python", "server.py"]
