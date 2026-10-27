import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { SSE_ROUTES } from '../src/sse.js';

// Static checks of the deployment files against the rules in PLAN.md.
// Behavioural tests live in deploy/test/*.sh (they need Docker).
const DEPLOY = path.resolve(__dirname, '../../../deploy');
const read = (p: string) => fs.readFileSync(path.join(DEPLOY, p), 'utf8');

interface ComposeService {
  image?: string;
  ports?: string[];
  network_mode?: string;
  volumes?: string[];
  environment?: Record<string, string>;
  restart?: string;
}
const compose = YAML.parse(read('docker-compose.yml')) as { services: Record<string, ComposeService> };

/** Splits nginx config into `location <match> { ... }` blocks (no nesting in our file). */
function locations(conf: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of conf.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)) out.set(m[1]!.trim(), m[2]!);
  return out;
}
const nginx = read('droplet/nginx/ipsengpt.conf');
const nginxLocations = locations(nginx);

describe('docker-compose.yml', () => {
  it('never publishes a port without 127.0.0.1: (Docker bypasses ufw)', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const p of svc.ports ?? []) expect(p, `${name}: ${p}`).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
    }
  });

  it('runs the app on host networking so it can reach the tunnel', () => {
    expect(compose.services.app?.network_mode).toBe('host');
    expect(compose.services.app?.ports).toBeUndefined();
  });

  it('keeps database, people and photos in host volumes', () => {
    const vols = compose.services.app?.volumes ?? [];
    for (const target of ['/data/db', '/data/people', '/data/photos']) {
      expect(vols.some((v) => v.endsWith(`:${target}`)), target).toBe(true);
    }
  });

  it('the image writes photos into the photos volume and reads gates from the mounted content', () => {
    const dockerfile = fs.readFileSync(path.join(DEPLOY, '../Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/PHOTOS_DIR=\/data\/photos\b/);
    expect(dockerfile).toMatch(/GATES_PATH=\/app\/content\/gates\.json\b/);
    expect(compose.services.app?.volumes).toContain('./content:/app/content:ro');
  });

  it('pins the fallback Ollama image and keeps its model loaded', () => {
    const ollama = compose.services.ollama!;
    expect(ollama.image).toMatch(/^ollama\/ollama:\d+\.\d+\.\d+$/);
    expect(ollama.environment?.OLLAMA_KEEP_ALIVE).toBe('-1');
    for (const svc of Object.values(compose.services)) expect(svc.restart).toBe('unless-stopped');
  });
});

describe('env.production.example', () => {
  const env = Object.fromEntries(
    read('env.production.example')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

  it('is a valid app config once ADMIN_PASSWORD is filled in', () => {
    const c = parseConfig({ ...env, ADMIN_PASSWORD: 'a-long-password' }, '/');
    expect(c.ollama.url).toBe('http://127.0.0.1:11435');
    expect(c.ollama.fallback?.url).toBe('http://127.0.0.1:11434');
    expect(c.ollama.connectTimeoutMs).toBe(3000);
    expect(c.ollama.firstTokenTimeoutMs).toBe(15000);
    expect(c.admin.cookieSecure).toBe(true);
    expect(c.photos.confidenceMin).toBe(0.7);
    expect(c.rateLimits.photoPerSession).toEqual({ count: 1, windowMs: 15_000 });
  });
});

describe('nginx site', () => {
  it('streams every SSE route unbuffered with a 1 h read timeout', () => {
    for (const route of SSE_ROUTES) {
      const block = nginxLocations.get(`= ${route}`);
      expect(block, `location = ${route}`).toBeDefined();
      expect(block).toMatch(/proxy_buffering off;/);
      expect(block).toMatch(/proxy_read_timeout 1h;/);
      expect(block).toMatch(/gzip off;/);
    }
  });

  it('allows 25 MB only on the photo upload route, 1 MB elsewhere', () => {
    expect(nginx).toMatch(/^\s*client_max_body_size 1m;/m);
    expect(nginxLocations.get('/api/photos/')).toMatch(/client_max_body_size 25m;/);
  });

  it('sets proxy headers once at server level (a location-level one would drop them all)', () => {
    for (const [loc, block] of nginxLocations) expect(block, loc).not.toMatch(/proxy_set_header/);
    expect(nginx).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
  });

  it('proxies only to the loopback app', () => {
    for (const m of nginx.matchAll(/proxy_pass\s+([^;]+);/g)) expect(m[1]).toBe('http://127.0.0.1:3000');
  });

  it('takes the domain from setup.sh (no hardcoded hostname)', () => {
    for (const m of nginx.matchAll(/server_name\s+([^;]+);/g)) expect(m[1]).toBe('__DOMAIN__');
    for (const m of nginx.matchAll(/ssl_certificate(?:_key)?\s+([^;]+);/g)) {
      expect(m[1]).toMatch(/^\/etc\/letsencrypt\/live\/__DOMAIN__\//);
    }
    expect(nginx).not.toMatch(/ipsen\.no/);
  });
});

describe('ssh hardening and tunnel', () => {
  const sshd = read('droplet/sshd/10-ipsengpt.conf');
  const lib = read('droplet/lib.sh');
  const tunnel = read('pc/tunnel.sh');

  it('sshd: no passwords, no gateway ports, tunnel user can only listen on 127.0.0.1:11435', () => {
    expect(sshd).toMatch(/^PasswordAuthentication no$/m);
    expect(sshd).toMatch(/^GatewayPorts no$/m);
    expect(sshd).toMatch(/Match User tunnel[\s\S]*PermitListen 127\.0\.0\.1:11435/);
    expect(lib).toContain('restrict,port-forwarding,permitlisten="%s"');
    expect(lib).toMatch(/^TUNNEL_LISTEN=127\.0\.0\.1:11435$/m);
  });

  it('tunnel.sh uses the reconnect-safe ssh options from the plan', () => {
    for (const opt of ['-N', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ExitOnForwardFailure=yes']) {
      expect(tunnel).toContain(opt);
    }
    expect(tunnel).toMatch(/^REMOTE_LISTEN=127\.0\.0\.1:11435$/m);
    expect(tunnel).toContain('-R "$REMOTE_LISTEN:$LOCAL_OLLAMA"');
  });

  it('ufw opens only 22, 80 and 443', () => {
    const allowed = [...lib.matchAll(/ufw allow (\S+)/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual(['22/tcp', '443/tcp', '80/tcp']);
  });
});
