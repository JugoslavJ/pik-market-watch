FROM node:24-alpine AS viewer-build
WORKDIR /viewer
COPY dashboard-viewer/package.json dashboard-viewer/package-lock.json ./
RUN npm ci --ignore-scripts
COPY dashboard-viewer/src ./src
COPY dashboard-viewer/vite.config.js ./
RUN npm run build

FROM apache/superset:6.0.0

USER root
RUN uv pip install --python /app/.venv/bin/python psycopg2-binary==2.9.10
COPY --chown=superset:superset superset/viewer.py superset/viewer_queries.py superset/definitions.py superset/listing_filters.py superset/board_access.py /app/
COPY --chown=superset:superset superset/access.py superset/client.py superset/validate_access.py superset/validate_viewer.py superset/benchmark_viewer.py superset/check_sync.py /app/
COPY --chown=superset:superset superset/dashboards /app/dashboards
COPY --from=viewer-build --chown=superset:superset /viewer/dist /app/viewer_dist
COPY --chown=superset:superset superset/superset_config.py /app/superset_config.py
USER superset
