import express from 'express';
import fs from 'fs';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const envPath = '/etc/sodium-daemon/.env';
let config: Record<string, string> = {};

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+)=(.+)$/);
    if (m) config[m[1]] = m[2].trim();
  }
}

loadEnv();

function verifyHmac(req: express.Request): boolean {
  const key = config.key;
  if (!key) return false;

  const timestamp = req.headers['x-sodium-timestamp'] as string;
  const signature = req.headers['x-sodium-signature'] as string;
  if (!timestamp || !signature) return false;

  const body = typeof req.body === 'object' ? JSON.stringify(req.body) : (req.body || '');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${timestamp}:${req.method}:${req.path}:${body}`)
    .digest('hex');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function verifyBasic(req: express.Request): boolean {
  const key = config.key;
  if (!key) return false;

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;
  const creds = Buffer.from(auth.slice(6), 'base64').toString();
  const [, password] = creds.split(':');
  return password === key;
}

function verifyAuth(req: express.Request): boolean {
  return verifyHmac(req) || verifyBasic(req);
}

app.use((req, res, next) => {
  if (verifyAuth(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.get('/', (_req, res) => {
  res.json({
    versionFamily: 'Sodium',
    versionRelease: '2.0.0',
    status: 'Online',
    remote: config.remote || '',
  });
});

app.get('/stats', async (_req, res) => {
  try {
    const si = await import('systeminformation');
    const [cpu, mem, fsInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
    ]);
    res.json({
      cpu: Math.round(cpu.currentLoad),
      ram: { used: Math.round(mem.used / 1024 / 1024), total: Math.round(mem.total / 1024 / 1024) },
      disk: fsInfo.map((d: any) => ({ used: Math.round(d.used / 1024 / 1024), total: Math.round(d.size / 1024 / 1024) })),
    });
  } catch {
    res.json({ cpu: 0, ram: { used: 0, total: 0 }, disk: [] });
  }
});

const port = parseInt(config.port || '3002', 10);
app.listen(port, () => {
  console.log(`Sodium Daemon listening on port ${port}`);
});
