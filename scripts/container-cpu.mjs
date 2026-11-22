// Prints {container: cumulative CPU seconds} for every running observability-lab container, read
// from the Docker Engine API (works even when a service exports no metrics).
// Usage: node scripts/container-cpu.mjs   (DOCKER_SOCK overrides the socket path)
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const sock = process.env.DOCKER_SOCK
  ?? execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim().replace(/^unix:\/\//, '');
const get = (path) => new Promise((resolve, reject) => {
  http.get({ socketPath: sock, path }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

const containers = await get('/containers/json');
const out = {};
await Promise.all(containers
  .filter((c) => c.Labels?.['com.docker.compose.project'] === 'observability-lab')
  .map(async (c) => {
    const s = await get(`/containers/${c.Id}/stats?stream=false&one-shot=true`);
    out[c.Labels['com.docker.compose.service']] = s.cpu_stats.cpu_usage.total_usage / 1e9;
  }));
console.log(JSON.stringify({ at: new Date().toISOString(), cpuSeconds: out }));
