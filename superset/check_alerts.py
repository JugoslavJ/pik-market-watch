"""Evaluate the two production pipeline alerts from PostgreSQL without Celery."""

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import psycopg2

STATE = Path("/app/superset_home/pipeline-alert-state.json")
STALE_HOURS = int(os.environ.get("SCRAPE_STALE_AFTER_HOURS", "26"))
NOW = datetime.now(timezone.utc)


def evaluate():
    conn = psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "db"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "olx"),
        user=os.environ["POSTGRES_REPORTING_USER"],
        password=os.environ["POSTGRES_REPORTING_PASSWORD"],
        connect_timeout=10,
        application_name="superset-pipeline-alert-checker",
    )
    conn.set_session(readonly=True, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT count(*)::int
                FROM lean.scrape_runs
                WHERE status = 'ok'
                  AND started_at > now() - interval '26 hours'
            """)
            ok_runs = cur.fetchone()[0]
            cur.execute("""
                SELECT ss.search_key, ss.name, success.finished_at
                FROM lean.saved_searches ss
                LEFT JOIN LATERAL (
                    SELECT r.finished_at
                    FROM lean.scrape_runs r
                    WHERE r.search_key = ss.search_key
                      AND r.status = 'ok' AND r.is_complete = TRUE
                      AND r.finished_at IS NOT NULL
                    ORDER BY r.finished_at DESC LIMIT 1
                ) success ON TRUE
                WHERE success.finished_at IS NULL
                   OR success.finished_at < now() - (%s * interval '1 hour')
                ORDER BY ss.name
            """, (STALE_HOURS,))
            stale_searches = [
                {"search_key": row[0], "name": row[1],
                 "last_success_at": row[2].isoformat() if row[2] else None}
                for row in cur.fetchall()
            ]
        return ok_runs, stale_searches
    finally:
        conn.close()


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix="pipeline-alert-state-", dir=STATE.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(state, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, STATE)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main():
    ok_runs, stale_searches = evaluate()
    conditions = {
        "no_successful_scrape_26h": ok_runs == 0,
        "stale_or_failing_saved_search": bool(stale_searches),
    }
    previous = load_state()
    state = {"updated_at": NOW.isoformat(), "conditions": {}}
    active = []
    resolved = []
    hold_minutes = {"no_successful_scrape_26h": 10,
                    "stale_or_failing_saved_search": 15}
    for name, failing in conditions.items():
        old = previous.get("conditions", {}).get(name, {})
        first_seen = old.get("first_seen") if failing and old.get("failing") else NOW.isoformat()
        elapsed = (NOW - datetime.fromisoformat(first_seen)).total_seconds() / 60 if failing else 0
        fired = failing and elapsed >= hold_minutes[name]
        state["conditions"][name] = {
            "failing": failing, "first_seen": first_seen if failing else None,
            "fired": bool(fired),
        }
        if fired:
            active.append(name)
        if old.get("fired") and not fired:
            resolved.append(name)

    payload = {
        "checked_at": NOW.isoformat(), "healthy_successful_runs_26h": ok_runs,
        "stale_after_hours": STALE_HOURS, "stale_searches": stale_searches,
        "active": active, "resolved": resolved,
    }
    print(json.dumps(payload, sort_keys=True))
    webhook = os.environ.get("ALERT_WEBHOOK_URL", "").strip()
    if webhook and (active != [n for n in active if previous.get("conditions", {}).get(n, {}).get("fired")] or resolved):
        request = Request(webhook, data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request, timeout=10) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"alert webhook returned HTTP {response.status}")
    save_state(state)
    return 1 if active else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        message = str(error)
        webhook = os.environ.get("ALERT_WEBHOOK_URL", "").strip()
        if webhook:
            message = message.replace(webhook, "[redacted webhook URL]")
        print(f"pipeline alert check failed: {message}", file=sys.stderr)
        sys.exit(2)
