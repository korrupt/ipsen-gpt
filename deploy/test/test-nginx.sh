#!/usr/bin/env bash
# Validates deploy/droplet/nginx/ipsengpt.conf: syntax (as installed, with the
# real Cloudflare snippet) and behaviour (in front of a stub upstream).
source "$(dirname "$0")/lib.sh"

# Same major version as Ubuntu 24.04's nginx package (1.24).
NGINX_IMAGE=nginx:1.24-alpine
WORK=$(mktemp -d)
NAME=ipsengpt-nginx-test-$$
UPSTREAM_PORT=$(free_port)
HTTP_PORT=$(free_port)
HTTPS_PORT=$(free_port)
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "Syntax check of the production config, as setup.sh installs it"
mkdir -p "$WORK/prod/conf.d" "$WORK/prod/sites" "$WORK/prod/le/live/artifical.ipsen.no"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=artifical.ipsen.no \
  -keyout "$WORK/prod/le/live/artifical.ipsen.no/privkey.pem" \
  -out "$WORK/prod/le/live/artifical.ipsen.no/fullchain.pem" >/dev/null 2>&1
"$DEPLOY_DIR/droplet/cloudflare-realip.sh" "$WORK/prod/conf.d/cloudflare-realip.conf" >/dev/null
pass "cloudflare-realip.sh fetched $(grep -c set_real_ip_from "$WORK/prod/conf.d/cloudflare-realip.conf") ranges"
cp "$DEPLOY_DIR/droplet/nginx/ipsengpt.conf" "$WORK/prod/sites/"
cat > "$WORK/prod/nginx.conf" <<'CONF'
events {}
http {
  include /etc/nginx/mime.types;
  include /etc/nginx/conf.d/*.conf;
  include /etc/nginx/sites-enabled/*;
}
CONF
out=$(docker run --rm \
  -v "$WORK/prod/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$WORK/prod/conf.d:/etc/nginx/conf.d:ro" \
  -v "$WORK/prod/sites:/etc/nginx/sites-enabled:ro" \
  -v "$WORK/prod/le:/etc/letsencrypt:ro" \
  "$NGINX_IMAGE" nginx -t 2>&1) || fail "nginx -t: $out"
pass "nginx -t accepts the production config"

step "Behaviour in front of a stub app"
node "$DEPLOY_DIR/test/stub-upstream.mjs" "$UPSTREAM_PORT" & STUB_PID=$!
wait_for 5 curl -sf "http://127.0.0.1:$UPSTREAM_PORT/" || fail "stub did not start"

mkdir -p "$WORK/run/conf.d"
# Same server blocks, with test ports and the stub as upstream.
sed -e "s/listen 80;/listen $HTTP_PORT;/; s/listen \[::\]:80;/listen [::]:$HTTP_PORT;/" \
    -e "s/listen 443 ssl;/listen $HTTPS_PORT ssl;/; s/listen \[::\]:443 ssl;/listen [::]:$HTTPS_PORT ssl;/" \
    -e "s#127.0.0.1:3000#127.0.0.1:$UPSTREAM_PORT#g" \
    -e "s#return 301 https://\$host\$request_uri;#return 301 https://\$host:$HTTPS_PORT\$request_uri;#" \
    "$DEPLOY_DIR/droplet/nginx/ipsengpt.conf" > "$WORK/run/conf.d/ipsengpt.conf"
# In the test, "Cloudflare" is localhost.
printf 'set_real_ip_from 127.0.0.1;\nreal_ip_header CF-Connecting-IP;\n' > "$WORK/run/conf.d/00-realip.conf"
docker run -d --name "$NAME" --network host \
  -v "$WORK/run/conf.d:/etc/nginx/conf.d:ro" \
  -v "$WORK/prod/le:/etc/letsencrypt:ro" \
  "$NGINX_IMAGE" >/dev/null
BASE="https://127.0.0.1:$HTTPS_PORT"
H=(-H 'Host: artifical.ipsen.no')
wait_for 10 curl -sk "${H[@]}" "$BASE/" || { docker logs "$NAME"; fail "nginx did not start"; }

loc=$(curl -s -o /dev/null -w '%{redirect_url}' "${H[@]}" "http://127.0.0.1:$HTTP_PORT/x?y=1")
assert_eq "$loc" "https://artifical.ipsen.no:$HTTPS_PORT/x?y=1" "http redirects to https"

echo_json=$(curl -sk "${H[@]}" -H 'CF-Connecting-IP: 203.0.113.7' -H 'X-Forwarded-For: 6.6.6.6' "$BASE/echo")
assert_contains "$echo_json" '"xff":"203.0.113.7"' "app sees the real client IP from Cloudflare"
assert_not_contains "$echo_json" '6.6.6.6' "client-supplied X-Forwarded-For is dropped"
assert_contains "$echo_json" '"proto":"https"' "X-Forwarded-Proto is https"
assert_contains "$echo_json" '"host":"artifical.ipsen.no"' "Host is passed through"

headers=$(curl -skI "${H[@]}" "$BASE/echo" | tr "[:upper:]" "[:lower:]")
assert_contains "$headers" "x-content-type-options: nosniff" "security headers set"

# Seconds until the first *body* bytes arrive (curl's time_starttransfer only
# covers headers, which Nginx sends immediately even when buffering the body).
first_body_byte() {
  python3 - "$1" <<'PY'
import socket, ssl, sys, time
port, path = sys.argv[1].split(" ", 1)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection(("127.0.0.1", int(port))), server_hostname="artifical.ipsen.no")
s.sendall(f"POST {path} HTTP/1.1\r\nHost: artifical.ipsen.no\r\nContent-Length: 0\r\n\r\n".encode())
t0, buf = time.time(), b""
while b"event: first" not in buf:
    chunk = s.recv(4096)
    if not chunk: break
    buf += chunk
print(f"{time.time() - t0:.3f}")
PY
}
for path in /api/chat /api/events; do
  t=$(first_body_byte "$HTTPS_PORT $path")
  python3 -c "import sys; sys.exit(0 if $t < 0.8 else 1)" \
    && pass "$path streams unbuffered (first event after ${t}s, upstream ends at 1.5s)" \
    || fail "$path is buffered (first event after ${t}s)"
done
assert_not_contains "$(curl -skI -X POST -H 'Accept-Encoding: gzip' "${H[@]}" "$BASE/api/chat" | tr '[:upper:]' '[:lower:]')" "content-encoding" "SSE is not compressed"

head -c 2000000 /dev/zero > "$WORK/2mb"; head -c 21000000 /dev/zero > "$WORK/21mb"; head -c 27000000 /dev/zero > "$WORK/27mb"
code() { curl -sk -o /dev/null -w '%{http_code}' -X POST "${H[@]}" --data-binary @"$1" "$BASE$2"; }
assert_eq "$(code "$WORK/2mb" /api/session)" 413 "2 MB body rejected on normal routes"
assert_eq "$(code "$WORK/21mb" /api/photos/original)" 200 "21 MB original photo accepted"
assert_eq "$(code "$WORK/27mb" /api/photos/original)" 413 "27 MB original photo rejected"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
