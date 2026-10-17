#!/usr/bin/env python3
"""Checkpoint helper: fail the build if any JavaScript is syntactically broken.

Extracts every <script> block from index.html and runs `node --check` on it,
plus the worker and the Cloudflare Worker source. A broken paste that would
make the app dead-on-arrival (which happened once) is caught here.
"""
import re, subprocess, sys, tempfile, os

FAILED = 0

def check(js, label, filename):
    global FAILED
    p = os.path.join(tempfile.gettempdir(), "syntaxcheck.js")
    with open(p, "w") as f:
        f.write(js)
    r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"::error file={filename}::{label} has a JavaScript syntax error")
        print(r.stderr.strip())
        FAILED = 1
    else:
        print(f"  OK    {label} parses")

html = open("index.html").read()
blocks = re.findall(r"<script>(.*?)</script>", html, re.DOTALL)
for i, b in enumerate(blocks):
    check(b, f"index.html script block {i}", "index.html")

for path in ("js/worker.js", "src/index.js"):
    if os.path.exists(path):
        check(open(path).read(), path, path)

if FAILED:
    print("")
    print("SYNTAX CHECK FAILED - the app would not run. DO NOT DEPLOY.")
    sys.exit(1)
print("All JavaScript parses cleanly.")
