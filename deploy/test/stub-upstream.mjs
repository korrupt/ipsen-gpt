// Stand-in for the app behind Nginx in test-nginx.sh.
import http from 'node:http';

const port = Number(process.argv[2]);
http
  .createServer(async (req, res) => {
    let size = 0;
    for await (const chunk of req) size += chunk.length;
    if (req.url === '/api/chat' || req.url === '/api/events') {
      // An SSE response whose second half arrives late: buffering would delay the first byte.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: first\ndata: {}\n\n');
      setTimeout(() => res.end('event: last\ndata: {}\n\n'), 1500);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        url: req.url,
        size,
        xff: req.headers['x-forwarded-for'] ?? null,
        proto: req.headers['x-forwarded-proto'] ?? null,
        host: req.headers.host ?? null,
      }),
    );
  })
  .listen(port, '127.0.0.1');
