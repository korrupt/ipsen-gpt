#!/usr/bin/env python3
"""Smoke test of the live site from the outside, as a guest's phone sees it.

  usage: deploy/test/smoke-prod.py [--host chat.ipsen.no] [--origin <droplet-ip>] [--no-chat]

Checks Cloudflare and TLS, the origin (with --origin: certificate, closed ports),
the guest flow, the live event stream, streaming replies from the real model,
one-reply-at-a-time, the per-guest rate limit, and the request size limit.

It creates one or two guests named "Smoke Test <n>" and sends about ten short
chats. End them afterwards in Admin -> Sessions. --no-chat skips everything
that asks the model (and creates only one guest).
Python 3 standard library only; run it before the party and after deploys.
"""
import argparse, http.client, json, random, socket, ssl, subprocess, sys, threading, time

p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
p.add_argument("--host", default="chat.ipsen.no")
p.add_argument("--origin", help="droplet IP: also test the origin directly, bypassing Cloudflare")
p.add_argument("--no-chat", action="store_true", help="don't ask the model (no chats, no rate-limit test)")
args = p.parse_args()
HOST = args.host
results = []


def check(ok, name, detail=""):
    results.append(bool(ok))
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {name}" + (f"  ({detail})" if detail else ""), flush=True)
    return ok


def step(title):
    print(f"\n\033[1m{title}\033[0m", flush=True)


def conn(ip=None, timeout=60):
    ctx = ssl.create_default_context()
    c = http.client.HTTPSConnection(HOST, 443, context=ctx, timeout=timeout)
    if ip:  # talk to the origin directly but verify the certificate for HOST
        c.sock = ctx.wrap_socket(socket.create_connection((ip, 443), timeout=timeout), server_hostname=HOST)
    return c


def req(method, path, body=None, token=None, ip=None):
    c = conn(ip)
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    c.request(method, path, body=data, headers=h)
    r = c.getresponse()
    raw = r.read()
    c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, raw


def read_events(r, until, on_event=None):
    """Reads SSE events from response r until `until(events)` is true (the connection's timeout
    bounds each read). Returns [(seconds, event, data)]."""
    t0, events, buf = time.time(), [], b""
    while not until(events):
        chunk = r.read1(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n\n" in buf:
            block, buf = buf.split(b"\n\n", 1)
            name, data = None, ""
            for line in block.decode().splitlines():
                if line.startswith("event:"):
                    name = line[6:].strip()
                elif line.startswith("data:"):
                    data += line[5:].strip()
            if name:
                events.append((time.time() - t0, name, json.loads(data)))
                if on_event:
                    on_event(name)
    return events


def chat(token, message, on_first=None):
    """Returns (status, events or error body, headers)."""
    c = conn()
    c.request("POST", "/api/chat", body=json.dumps({"message": message}).encode(),
              headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                       "Accept": "text/event-stream"})
    r = c.getresponse()
    if r.status != 200:
        body = r.read()
        c.close()
        return r.status, body.decode(errors="replace"), {}
    started = []

    def first(name):
        if name == "token" and not started:
            started.append(1)
            on_first and on_first()

    events = read_events(r, lambda ev: ev and ev[-1][1] in ("done", "error"), first)
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    c.close()
    return 200, events, hdrs


def new_guest():
    name = f"Smoke Test {random.randint(100, 999)}"
    s, _, body = req("POST", "/api/session", {"name": name})
    return s, name, (json.loads(body) if s == 201 else body)


guests = []

step(f"Edge (Cloudflare) and TLS: https://{HOST}")
s, h, body = req("GET", "/api/health")
check(s == 200 and json.loads(body) == {"ok": True}, "health")
check("cloudflare" in h.get("server", "").lower(), "traffic goes through Cloudflare", f"server: {h.get('server')}")
out = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", f"http://{HOST}/x"],
                     capture_output=True, text=True).stdout.split()
check(out[:1] in (["301"], ["308"]) and out[1:2] and out[1].startswith("https://"), "http redirects to https", " ".join(out))
s, h, body = req("GET", "/")
check(s == 200 and b"<html" in body.lower(), "guest page served")
check(h.get("x-content-type-options") == "nosniff" and h.get("x-frame-options") == "DENY"
      and h.get("referrer-policy") == "same-origin", "security headers present")
s, h, _ = req("GET", "/admin")
check(s == 301 and h.get("location", "").endswith("/admin/"), "/admin redirects to /admin/")
s, _, body = req("GET", "/admin/")
check(s == 200 and b"<html" in body.lower(), "admin page served")

if args.origin:
    step(f"Origin {args.origin} (bypassing Cloudflare)")
    try:
        c = conn(args.origin)
        c.connect() if c.sock is None else None
        cert = c.sock.getpeercert()
        days = (ssl.cert_time_to_seconds(cert["notAfter"]) - time.time()) / 86400
        issuer = dict(x[0] for x in cert["issuer"]).get("organizationName", "?")
        c.close()
        check(days > 14, f"certificate valid for {HOST}", f"{issuer}, {days:.0f} days left")
    except Exception as e:  # noqa: BLE001
        check(False, f"certificate valid for {HOST}", repr(e))
    s, _, _ = req("GET", "/api/health", ip=args.origin)
    check(s == 200, "origin answers health directly")
    for port in (3000, 11434, 11435):
        try:
            socket.create_connection((args.origin, port), timeout=4).close()
            check(False, f"port {port} closed from the internet", "OPEN")
        except OSError:
            check(True, f"port {port} closed from the internet")

step("Guest flow")
s, name, body = new_guest()
check(s == 201, "create a guest", f"{name}, status {s}")
if s != 201:
    sys.exit(1)
guests.append(name)
token = body["token"]
check(body.get("gate") is None, "no gate blocks a new guest", str(body.get("gate")))
s, _, _ = req("GET", "/api/session", token="not-a-real-token")
check(s == 401, "bad token rejected")
s, _, _ = req("POST", "/api/chat", {"message": "   "}, token=token)
check(s == 400, "empty message rejected")
s, _, _ = req("POST", "/api/chat", {"message": "x" * 501}, token=token)
check(s == 400, "501-char message rejected")

step("Live events through Cloudflare")
c = conn(timeout=10)
c.request("GET", "/api/events", headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"})
r = c.getresponse()
check(r.status == 200 and r.getheader("content-type", "").startswith("text/event-stream"), "event stream opens", f"status {r.status}")
status = None
try:
    events = read_events(r, lambda ev: {"status", "gate"} <= {e[1] for e in ev})
    names = {e[1]: e for e in events}
    check("status" in names and "gate" in names, "status and gate arrive at once (not buffered)",
          ", ".join(f"{n} after {names[n][0]:.2f}s" for n in names))
    status = names.get("status", (0, 0, {}))[2]
except (socket.timeout, TimeoutError):
    check(False, "status and gate arrive at once (not buffered)", "nothing within 10 s")
c.close()
chat_open = bool(status and status.get("open"))
check(chat_open, "chat is open (the PC is connected and chat isn't paused)",
      "" if chat_open else f"guests see: {status and status.get('message')}")

if args.no_chat or not chat_open:
    step("Chat tests skipped" + ("" if args.no_chat else ": chat is closed"))
else:
    step("Streaming a reply from the model")
    s, events, hdrs = chat(token, "Introduce yourself in about 60 words.")
    toks = [e for e in events if e[1] == "token"] if s == 200 else []
    check(s == 200 and events[-1][1] == "done", "reply completes", f"{len(toks)} token events" if s == 200 else events)
    if toks:
        first, last = toks[0][0], toks[-1][0]
        slots = len({round(t, 1) for t, _, _ in toks})
        check(last - first > 0.3 and slots > 3, "tokens arrive spread out (not buffered)",
              f"first {first:.2f}s, last {last:.2f}s, {slots} distinct 100 ms slots")
        check(not {"gzip", "br"} & set(hdrs.get("content-encoding", "").split(",")), "stream not compressed")
        reply = "".join(e[2]["text"] for e in toks)
        print(f"    reply: {reply[:140]!r}{'…' if len(reply) > 140 else ''}")
        print(f"    ~{len(toks) / max(last - first, 0.01):.0f} token events/s")

    step("One reply at a time per guest")
    s, name, body = new_guest()
    guests.append(name)
    t2 = body["token"]
    started, holder = threading.Event(), {}
    th = threading.Thread(target=lambda: holder.update(r=chat(t2, "Tell a spooky story of about 250 words.", started.set)))
    th.start()
    started.wait(30)
    s, _, body = req("POST", "/api/chat", {"message": "hi"}, token=t2)
    check(s == 429, "a second message while one streams gets 429 busy", body.decode()[:70])
    th.join()
    check(holder["r"][0] == 200 and holder["r"][1][-1][1] == "done", "the first reply still completes")

    step("Rate limit: 8 chats a minute per guest (1 used above)")
    codes = []
    for _ in range(8):
        s, _, _ = chat(t2, "Reply with one word.")
        codes.append(s)
        if s == 429:
            break
    check(codes[:7] == [200] * 7 and codes[-1] == 429, "the 9th chat in a minute is refused", str(codes))

step("Request size limit")
s, _, _ = req("POST", "/api/session", b"x" * 2_000_000)
check(s == 413, "2 MB body rejected on normal routes", f"status {s}")

ok = all(results)
print(f"\n\033[{'32' if ok else '31'}m{sum(results)}/{len(results)} checks passed\033[0m")
print(f"Test guests to end in Admin -> Sessions: {', '.join(guests)}")
sys.exit(0 if ok else 1)
