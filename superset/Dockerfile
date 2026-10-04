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
COPY superset/patch_frontend.py /tmp/patch_frontend.py
COPY superset/dashboard_requests.js /tmp/dashboard_requests.js
RUN /app/.venv/bin/python /tmp/patch_frontend.py
COPY --chown=superset:superset superset/dashboard_data.py /app/dashboard_data.py
COPY --chown=superset:superset superset/dashboard_projection.py /app/dashboard_projection.py
COPY --chown=superset:superset superset/template_cache.py /app/template_cache.py
COPY --chown=superset:superset superset/viewer.py superset/viewer_queries.py superset/parity.py superset/provisioning.py superset/maps.py /app/
COPY --chown=superset:superset superset/validate_viewer.py superset/benchmark_viewer.py /app/
COPY --chown=superset:superset grafana/dashboards-lean /app/viewer_sources
COPY --from=viewer-build --chown=superset:superset /viewer/dist /app/viewer_dist
COPY --chown=superset:superset superset/superset_config.py /app/superset_config.py
USER superset
