#!/usr/bin/env python3
"""Just enough of PostgREST to run real sync cycles against a local Postgres,
with row-level security on. The bearer token is the user's id. See README.md."""
import json
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qsl, urlparse

DB_ARGS = ["psql", "-h", "127.0.0.1", "-p", sys.argv[2], "-U", "postgres", "-d", sys.argv[3], "-qAtX", "-v", "ON_ERROR_STOP=1"]
TABLES = {"projects", "features", "phases", "member_state", "time_entries", "timers"}
ONE_ROW = {"ensure_profile", "set_display_name", "push_timer"}
SCALAR = {"add_member", "remove_member"}
NAME = re.compile(r"^[a-z_]+$")


def literal(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def run(user, statement):
    claims = json.dumps({"sub": user, "email": f"{user[-1]}@x.com", "role": "authenticated"})
    script = (f"begin; select set_config('request.jwt.claims', {literal(claims)}, true) \\g /dev/null\n"
              f"set local role authenticated; {statement}; commit;")
    return subprocess.run(DB_ARGS, input=script, capture_output=True, text=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body=""):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def finish_sql(self, result, shape=None):
        if result.returncode != 0:
            refused = "row-level security" in result.stderr or "permission denied" in result.stderr
            message = re.sub(r"^.*?ERROR:\s*", "", result.stderr.strip().split("\n")[0])
            return self.reply(403 if refused else 400, json.dumps({"message": message}))
        out = result.stdout.strip()
        if shape == "one":
            rows = json.loads(out or "[]")
            return self.reply(200, json.dumps(rows[0] if rows else None))
        if shape == "scalar":
            rows = json.loads(out or "[]")
            value = rows[0] if rows else None
            return self.reply(200, json.dumps(value) if value not in (None, "") else "")
        return self.reply(200, out or "")

    def do_GET(self):
        url = urlparse(self.path)
        table = url.path.rsplit("/", 1)[1]
        if table not in TABLES:
            return self.reply(404, json.dumps({"message": f"no table {table}"}))
        where, order, limit = [], "", ""
        for key, value in parse_qsl(url.query):
            if key == "order":
                order = "order by " + value.replace(".asc", " asc")
            elif key == "limit":
                limit = f"limit {int(value)}"
            elif key != "select":
                op, operand = value.split(".", 1)
                where.append(f"{key} {'>' if op == 'gt' else '='} {literal(operand)}")
        clause = f"where {' and '.join(where)}" if where else ""
        self.finish_sql(run(self.user(), f"select coalesce(json_agg(r), '[]') from (select * from public.{table} {clause} {order} {limit}) r"))

    def user(self):
        return self.headers["Authorization"].split()[1]

    def do_POST(self):
        url = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        name = url.path.rsplit("/", 1)[1]
        if "/rpc/" in url.path:
            args = ", ".join(f"{k} => {literal(v)}" for k, v in body.items())
            shape = "one" if name in ONE_ROW else "scalar" if name in SCALAR else None
            return self.finish_sql(run(self.user(), f"select coalesce(json_agg(r), '[]') from public.{name}({args}) r"), shape)
        if name not in TABLES:
            return self.reply(404, json.dumps({"message": f"no table {name}"}))
        columns = list(body[0].keys())
        assert all(NAME.match(c) for c in columns)
        names = ", ".join(columns)
        updates = ", ".join(f"{c} = excluded.{c}" for c in columns)
        self.finish_sql(run(self.user(), (
            f"insert into public.{name} ({names}) select {names} "
            f"from json_populate_recordset(null::public.{name}, {literal(json.dumps(body))}) "
            f"on conflict (id) do update set {updates}")))


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
