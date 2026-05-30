import { execSync } from 'child_process';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import Dockerode from 'dockerode';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import type { IncomingMessage } from 'http';

const DATA_DIR = '/var/lib/sodium-daemon';
const CONTAINERS_DIR = path.join(DATA_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

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

try {
  fs.mkdirSync(CONTAINERS_DIR, { recursive: true });
} catch { /* ignore */ }

// Install state tracking (in-memory, ephemeral)
const installStates = new Map<string, string>();

function loadInstallStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.installStates && typeof data.installStates === 'object') {
        for (const [k, v] of Object.entries(data.installStates)) {
          installStates.set(k, v as string);
        }
      }
    }
  } catch { /* ignore corrupt state file */ }
}

function saveInstallStates() {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of installStates) {
      obj[k] = v;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ installStates: obj }), 'utf-8');
  } catch { /* non-fatal */ }
}

function setInstallState(uuid: string, state: string) {
  installStates.set(uuid, state);
  saveInstallStates();
}

function getInstallState(uuid: string): string {
  return installStates.get(uuid) || 'installing';
}

// Load persisted states on startup
loadInstallStates();

// ── Container name helper ──────────────────────────────────────────────────

function containerName(uuid: string): string {
  return `sodium-${uuid}`;
}

function dataDir(uuid: string): string {
  const dir = path.join(CONTAINERS_DIR, uuid);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
  return dir;
}

// ── Docker client ──────────────────────────────────────────────────────────

let docker: Dockerode;
try {
  docker = new Dockerode();
} catch {
  // Docker not available – operations will fail with a clear error
}

function ensureDocker(): Dockerode {
  if (!docker) throw new Error('Docker is not available on this system');
  return docker;
}

// ── Auth ───────────────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────

function getContainer(uuid: string): Dockerode.Container {
  const d = ensureDocker();
  return d.getContainer(containerName(uuid));
}

async function containerExists(uuid: string): Promise<boolean> {
  try {
    const c = getContainer(uuid);
    await c.inspect();
    return true;
  } catch {
    return false;
  }
}

// Run a command inside a container (must be running)
async function execInContainer(uuid: string, cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const d = ensureDocker();
  const c = d.getContainer(containerName(uuid));
  const exec = await c.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ Detach: false, Tty: false });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    stream.on('data', (chunk: Buffer) => {
      // Docker multiplexes streams: first byte is stream type (1=stdout, 2=stderr)
      const type = chunk[0];
      const data = chunk.slice(8).toString('utf-8'); // skip 8-byte header
      if (type === 1) stdout += data;
      else if (type === 2) stderr += data;
    });
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        resolve({ exitCode: info.ExitCode ?? -1, stdout, stderr });
      } catch {
        resolve({ exitCode: -1, stdout, stderr });
      }
    });
    stream.on('error', reject);
  });
}

// Run a command in a fresh Alpine container with the data volume mounted
async function execInWorker(uuid: string, cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const d = ensureDocker();
  const dir = dataDir(uuid);

  const container = await d.createContainer({
    Image: 'alpine:3.19',
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${dir}:/home/container`],
      AutoRemove: true,
    },
    WorkingDir: '/home/container',
  });

  const stream = await container.attach({ stream: true, stdout: true, stderr: true });
  await container.start();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    stream.on('data', (chunk: Buffer) => {
      const type = chunk[0];
      const data = chunk.slice(8).toString('utf-8');
      if (type === 1) stdout += data;
      else if (type === 2) stderr += data;
    });
    stream.on('end', async () => {
      try {
        const info = await container.wait();
        resolve({ exitCode: info.StatusCode, stdout, stderr });
      } catch {
        resolve({ exitCode: -1, stdout, stderr });
      }
    });
    stream.on('error', reject);
  });
}

// ── Express app ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.use((req, res, next) => {
  if (verifyAuth(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Health / Stats ────────────────────────────────────────────────────────

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

// ── Container: Install (Pterodactyl egg style) ────────────────────────────

app.post('/container/installer', async (req, res) => {
  let id: string | undefined;
  try {
    const body = req.body as { id?: string; script?: string; container?: string; entrypoint?: string; env?: Record<string, string> };
    id = body.id;
    const script = body.script;
    const image = body.container;
    const entrypoint = body.entrypoint;
    const env = body.env;

    if (!id || !script) {
      return res.status(400).json({ error: 'Missing id or script' });
    }

    setInstallState(id, 'installing');
    const dir = dataDir(id);
    const d = ensureDocker();

    const envArray: string[] = [];
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        envArray.push(`${k}=${v}`);
      }
    }

    const installContainer = await d.createContainer({
      name: `sodium-install-${id}`,
      Image: image || 'alpine:3.19',
      Cmd: [entrypoint || 'bash', '-c', script],
      Env: envArray,
      HostConfig: {
        Binds: [`${dir}:/home/container`],
        AutoRemove: true,
      },
      WorkingDir: '/home/container',
    });

    try {
      await installContainer.start();
      await installContainer.wait();
      // Auto-accept EULA for Minecraft servers
      try {
        fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true', 'utf-8');
      } catch { /* non-fatal */ }
      setInstallState(id, 'installed');
      res.json({ success: true, state: 'installed' });
    } catch (err: any) {
      setInstallState(id, 'failed');
      res.status(500).json({ error: 'Installation failed', details: (err as Error).message });
    }
  } catch (err: any) {
    if (id) setInstallState(id, 'failed');
    res.status(500).json({ error: 'Failed to start installation', details: (err as Error).message });
  }
});

// ── Container: Install (legacy ALC style) ─────────────────────────────────

app.post('/container/install', async (req, res) => {
  let id: string | undefined;
  try {
    const body = req.body as { id?: string; image?: string; env?: Record<string, string>; scripts?: Array<{ url?: string; fileName?: string; ALVKT?: boolean; onStart?: boolean }> };
    id = body.id;
    const image = body.image;
    const env = body.env;
    const scripts = body.scripts;

    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    setInstallState(id, 'installing');
    const dir = dataDir(id);

    if (image) {
      try {
        const d = ensureDocker();
        await d.pull(image);
      } catch { /* non-fatal */ }
    }

    if (Array.isArray(scripts) && scripts.length > 0) {
      for (const s of scripts) {
        if (s.url) {
          const fileName = s.fileName || path.basename(new URL(s.url).pathname);
          const filePath = path.join(dir, fileName);

          try {
            const resp = await fetch(s.url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());

            const contentType = resp.headers.get('content-type') || '';
            const isTar = fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz') || contentType.includes('gzip') || contentType.includes('tar');
            const isZip = fileName.endsWith('.zip') || contentType.includes('zip');

            if (isTar) {
              fs.writeFileSync(filePath, buf);
              execSync(`tar -xzf "${filePath}" -C "${dir}"`, { stdio: 'ignore' });
              try { fs.unlinkSync(filePath); } catch { /* ok */ }
            } else if (isZip) {
              fs.writeFileSync(filePath, buf);
              execSync(`unzip -o "${filePath}" -d "${dir}"`, { stdio: 'ignore' });
              try { fs.unlinkSync(filePath); } catch { /* ok */ }
            } else {
              fs.writeFileSync(filePath, buf);
              if (s.ALVKT) {
                try { fs.chmodSync(filePath, 0o755); } catch { /* ok */ }
              }
            }
          } catch {
            // Continue with other scripts even if one fails
          }
        }
      }
    }

    // Auto-accept EULA for Minecraft servers
    try {
      fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true', 'utf-8');
    } catch { /* non-fatal */ }
    setInstallState(id, 'installed');
    res.json({ success: true, state: 'installed' });
  } catch (err) {
    if (id) setInstallState(id, 'failed');
    res.status(500).json({ error: 'Installation failed', details: (err as Error).message });
  }
});

// ── Container: Start ──────────────────────────────────────────────────────

app.post('/container/start', async (req, res) => {
  try {
    const { id, image, ports, Memory, Cpu, Storage, env, StartCommand } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const d = ensureDocker();
    const dir = dataDir(id);
    const name = containerName(id);

    const envArray: string[] = [];
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        envArray.push(`${k}=${v}`);
      }
    }
    // Auto-accept EULA for Minecraft servers
    if (!envArray.some(e => e.startsWith('EULA='))) {
      envArray.push('EULA=true');
    }

    // Memory limit: convert MB to bytes
    const memoryLimit = Memory ? Memory * 1024 * 1024 : 0;
    // CPU limit: percentage * cpu count (e.g., 100% = 1 core = 100000)
    const cpuLimit = Cpu ? Cpu * 1000 : 0; // will be set as --cpus

    // Check if container already exists
    const exists = await containerExists(id);

    if (!exists) {
      // Port mapping
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      const exposedPorts: Record<string, object> = {};

      if (ports) {
        const portKey = `${ports}/tcp`;
        exposedPorts[portKey] = {};
        portBindings[portKey] = [{ HostPort: String(ports) }];
      }

      await d.createContainer({
        name,
        Image: image || 'alpine:3.19',
        Cmd: ['/bin/bash', '-c', StartCommand || 'sleep infinity'],
        Env: envArray,
        ExposedPorts: exposedPorts,
        HostConfig: {
          Binds: [`${dir}:/home/container`],
          PortBindings: portBindings,
          Memory: memoryLimit || undefined,
          NanoCpus: cpuLimit || undefined,
          MemorySwap: memoryLimit ? memoryLimit : undefined,
        },
        WorkingDir: '/home/container',
        OpenStdin: true,
        Tty: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });
    }

    const container = d.getContainer(name);
    await container.start();
    res.json({ success: true, message: 'Container started' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to start container', details: err.message });
  }
});

// ── Container: Stop ───────────────────────────────────────────────────────

app.post('/container/stop', async (req, res) => {
  try {
    const { id, stopCmd } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    if (!await containerExists(id)) {
      return res.status(404).json({ error: 'Container does not exist' });
    }

    const d = ensureDocker();
    const container = d.getContainer(containerName(id));

    try {
      const info = await container.inspect();
      if (info.State.Running) {
        // Send stop command if specified
        if (stopCmd) {
          try {
            const exec = await container.exec({
              Cmd: ['bash', '-c', `echo "${stopCmd}" > /proc/1/fd/0 2>/dev/null || ${stopCmd}`],
              AttachStdout: false,
              AttachStderr: false,
            });
            await exec.start({ Detach: true });
          } catch { /* exec may fail, that's ok */ }
        }

        // Give it a moment then force stop
        setTimeout(async () => {
          try {
            await container.stop({ t: 10 });
          } catch {
            try { await container.kill(); } catch { /* ok */ }
          }
        }, 2000);

        res.json({ success: true, message: 'Container stopping' });
      } else {
        res.json({ success: true, message: 'Container already stopped' });
      }
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to stop container', details: err.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to stop container', details: err.message });
  }
});

// ── Container: Delete ────────────────────────────────────────────────────

app.delete('/container', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    if (!await containerExists(id)) {
      return res.status(404).json({ error: 'Container does not exist' });
    }

    const d = ensureDocker();
    const container = d.getContainer(containerName(id));

    try {
      await container.stop({ t: 5 });
    } catch { /* already stopped */ }

    try {
      await container.remove({ v: true });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to remove container', details: err.message });
    }

    // Remove install state
    installStates.delete(id);

    res.json({ success: true, message: 'Container deleted' });
  } catch (err: any) {
    const is404 = err.statusCode === 404 || (err.message && err.message.includes('not exist'));
    if (is404) {
      return res.status(404).json({ error: 'Container does not exist' });
    }
    res.status(500).json({ error: 'Failed to delete container', details: err.message });
  }
});

// ── Container: Status ─────────────────────────────────────────────────────

app.get('/container/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const state = getInstallState(id);

    if (state === 'installed') {
      try {
        if (await containerExists(id)) {
          const d = ensureDocker();
          const info = await d.getContainer(containerName(id)).inspect();
          res.json({
            state: 'installed',
            running: info.State.Running,
            status: info.State.Status,
          });
        } else {
          res.json({ state: 'installed', running: false, status: 'not_created' });
        }
      } catch {
        res.json({ state: 'installed', running: false, status: 'unknown' });
      }
    } else if (state === 'failed') {
      res.json({ state: 'failed' });
    } else {
      res.json({ state: 'installing' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get status', details: err.message });
  }
});

// ── Container: Install Status (for install progress polling) ──────────────

app.get('/container/install-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const state = getInstallState(id);
    res.json({ state });
  } catch {
    res.json({ state: 'unknown' });
  }
});

// ── File System: List ─────────────────────────────────────────────────────

app.get('/fs/list', async (req, res) => {
  try {
    const id = req.query.id as string;
    const listPath = (req.query.path as string) || '/';

    if (!id) return res.status(400).json({ error: 'Missing id' });

    const dir = dataDir(id);
    const fullPath = path.join(dir, listPath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.json([]);
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const result = entries
      .filter(e => e.name !== 'sodium')
      .map(e => {
        const stats = fs.statSync(path.join(fullPath, e.name));
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => {
        if (a.type === 'directory' && b.type === 'file') return -1;
        if (a.type === 'file' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list files', details: err.message });
  }
});

// ── File System: Read file content ────────────────────────────────────────

app.get('/fs/file/content', async (req, res) => {
  try {
    const id = req.query.id as string;
    const filePath = req.query.path as string;

    if (!id || !filePath) return res.status(400).json({ error: 'Missing id or path' });

    const dir = dataDir(id);
    const fullPath = path.join(dir, filePath);

    if (!fullPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    res.send(content);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read file', details: err.message });
  }
});

// ── File System: Write file content ───────────────────────────────────────

app.post('/fs/file/content', async (req, res) => {
  try {
    const { id, path: filePath, content } = req.body;

    if (!id || !filePath) return res.status(400).json({ error: 'Missing id or path' });

    const dir = dataDir(id);
    const fullPath = path.join(dir, filePath);

    if (!fullPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Ensure parent directory exists
    try { fs.mkdirSync(path.dirname(fullPath), { recursive: true }); } catch { /* ok */ }

    fs.writeFileSync(fullPath, content, 'utf-8');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to write file', details: err.message });
  }
});

// ── File System: Upload ───────────────────────────────────────────────────

app.post('/fs/upload', async (req, res) => {
  try {
    const { id, path: uploadPath, fileName, fileContent } = req.body;

    if (!id || !fileName || !fileContent) {
      return res.status(400).json({ error: 'Missing id, fileName, or fileContent' });
    }

    const dir = dataDir(id);
    const relativePath = uploadPath || '/';
    const fullDir = path.join(dir, relativePath);

    if (!fullDir.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    try { fs.mkdirSync(fullDir, { recursive: true }); } catch { /* ok */ }

    // Handle both base64 data URIs and raw base64
    let buffer: Buffer;
    if (fileContent.startsWith('data:')) {
      const base64 = fileContent.split(',')[1];
      buffer = Buffer.from(base64, 'base64');
    } else {
      buffer = Buffer.from(fileContent, 'base64');
    }

    fs.writeFileSync(path.join(fullDir, fileName), buffer);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to upload file', details: err.message });
  }
});

// ── File System: Download ─────────────────────────────────────────────────

app.get('/fs/download', async (req, res) => {
  try {
    const id = req.query.id as string;
    const filePath = req.query.path as string;

    if (!id || !filePath) return res.status(400).json({ error: 'Missing id or path' });

    const dir = dataDir(id);
    const fullPath = path.join(dir, filePath);

    if (!fullPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileName = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to download file', details: err.message });
  }
});

// ── File System: Delete ───────────────────────────────────────────────────

app.delete('/fs/rm', async (req, res) => {
  try {
    const { id, path: rmPath } = req.body;

    if (!id || !rmPath) return res.status(400).json({ error: 'Missing id or path' });

    const dir = dataDir(id);
    const fullPath = path.join(dir, rmPath);

    if (!fullPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete', details: err.message });
  }
});

// ── File System: Rename ───────────────────────────────────────────────────

app.post('/fs/rename', async (req, res) => {
  try {
    const { id, path: renamePath, newName, newPath } = req.body;

    if (!id || !renamePath || !newName) {
      return res.status(400).json({ error: 'Missing id, path, or newName' });
    }

    const dir = dataDir(id);
    const oldFullPath = path.join(dir, renamePath);

    if (!oldFullPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(oldFullPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    // If newPath is provided, use it as the destination
    const destPath = newPath ? path.join(dir, newPath) : path.join(path.dirname(oldFullPath), newName);

    if (!destPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid destination path' });
    }

    // Create parent directory if needed
    try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch { /* ok */ }

    fs.renameSync(oldFullPath, destPath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to rename', details: err.message });
  }
});

// ── File System: Zip ──────────────────────────────────────────────────────

app.post('/fs/zip', async (req, res) => {
  try {
    const { id, path: zipPath, zipname } = req.body;
    if (!id || !zipPath || !zipname) {
      return res.status(400).json({ error: 'Missing id, path, or zipname' });
    }

    const dir = dataDir(id);
    const sourcePath = path.join(dir, zipPath);
    const outputPath = path.join(dir, zipname);

    if (!sourcePath.startsWith(dir) || !outputPath.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    // Use exec to create zip (requires zip to be installed on host)
    const cwd = path.dirname(sourcePath);
    const target = path.basename(sourcePath);

    try {
      execSync(`zip -r "${outputPath}" "${target}"`, { cwd, stdio: 'pipe', timeout: 300000 });
    } catch {
      // Fallback: use tar+gzip if zip is not available
      execSync(`tar -czf "${outputPath}" "${target}"`, { cwd, stdio: 'pipe', timeout: 300000 });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create archive', details: err.message });
  }
});

// ── File System: Unzip ────────────────────────────────────────────────────

app.post('/fs/unzip', async (req, res) => {
  try {
    const { id, path: unzipPath, zipname } = req.body;
    if (!id || !zipname) {
      return res.status(400).json({ error: 'Missing id or zipname' });
    }

    const dir = dataDir(id);
    const archivePath = path.join(dir, zipname);
    const targetDir = unzipPath ? path.join(dir, unzipPath) : dir;

    if (!archivePath.startsWith(dir) || !targetDir.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(archivePath)) {
      return res.status(404).json({ error: 'Archive not found' });
    }

    try { fs.mkdirSync(targetDir, { recursive: true }); } catch { /* ok */ }

    try {
      execSync(`unzip -o "${archivePath}" -d "${targetDir}"`, { stdio: 'pipe', timeout: 300000 });
    } catch {
      // Fallback: try tar
      execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'pipe', timeout: 300000 });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to extract archive', details: err.message });
  }
});

// ── File System: Create Empty File (for chunked upload) ──────────────────

app.post('/fs/create-empty-file', async (req, res) => {
  try {
    const { id, path: filePath, fileName } = req.body;
    if (!id || !fileName) {
      return res.status(400).json({ error: 'Missing id or fileName' });
    }

    const dir = dataDir(id);
    const relativePath = filePath || '/';
    const fullDir = path.join(dir, relativePath);

    if (!fullDir.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    try { fs.mkdirSync(fullDir, { recursive: true }); } catch { /* ok */ }

    const fullPath = path.join(fullDir, fileName);
    fs.writeFileSync(fullPath, '');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create empty file', details: err.message });
  }
});

// ── File System: Append File (for chunked upload) ────────────────────────

app.post('/fs/append-file', async (req, res) => {
  try {
    const { id, path: filePath, fileName, fileContent, chunkIndex, totalChunks } = req.body;
    if (!id || !fileName || !fileContent) {
      return res.status(400).json({ error: 'Missing id, fileName, or fileContent' });
    }

    const dir = dataDir(id);
    const relativePath = filePath || '/';
    const fullDir = path.join(dir, relativePath);

    if (!fullDir.startsWith(dir)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullPath = path.join(fullDir, fileName);

    // Decode base64 content (data URI or raw)
    let buffer: Buffer;
    if (typeof fileContent === 'string' && fileContent.startsWith('data:')) {
      const base64 = fileContent.split(',')[1];
      buffer = Buffer.from(base64, 'base64');
    } else {
      buffer = Buffer.from(fileContent, 'base64');
    }

    fs.appendFileSync(fullPath, buffer);
    res.json({ success: true, chunkIndex, totalChunks });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to append file', details: err.message });
  }
});

// ── SFTP: Credentials ────────────────────────────────────────────────────

// In-memory SFTP credential store
interface SftpCredential {
  username: string;
  password: string;
  port: number;
  createdAt: Date;
  expiresAt: Date;
}
const sftpCredentials = new Map<string, SftpCredential>();

app.post('/sftp/credentials', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const dir = dataDir(id);

    // Generate random username and password
    const username = `sftp-${id.slice(0, 8)}`;
    const password = crypto.randomBytes(16).toString('hex');
    const port = 2022; // Default SFTP port for container
    const expiresAt = new Date(Date.now() + 86400000); // 24 hours

    // Store credentials in memory
    sftpCredentials.set(id, {
      username,
      password,
      port,
      createdAt: new Date(),
      expiresAt,
    });

    // Attempt to create the system user if possible (non-fatal if it fails)
    try {
      execSync(`useradd -m -d "${dir}" -s /bin/bash "${username}" 2>/dev/null || adduser -D -h "${dir}" -s /bin/bash "${username}" 2>/dev/null || true`, { stdio: 'ignore' });
      execSync(`echo "${username}:${password}" | chpasswd 2>/dev/null || echo "${username}:${password}" | chpasswd 2>/dev/null || true`, { stdio: 'ignore' });
    } catch { /* system user management may not be available in container */ }

    res.json({
      username,
      password,
      port,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create SFTP credentials', details: err.message });
  }
});

app.delete('/sftp/credentials', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const cred = sftpCredentials.get(id);
    if (cred) {
      // Attempt to remove the system user
      try {
        execSync(`userdel "${cred.username}" 2>/dev/null || deluser "${cred.username}" 2>/dev/null || true`, { stdio: 'ignore' });
      } catch { /* ok */ }
      sftpCredentials.delete(id);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to revoke SFTP credentials', details: err.message });
  }
});

// ── Radar: Scan ─────────────────────────────────────────────────────────

app.post('/radar/scan', async (req, res) => {
  try {
    const { id, script } = req.body;
    if (!id || !script) {
      return res.status(400).json({ error: 'Missing id or script' });
    }

    const dir = dataDir(id);
    const results: Array<{ pattern: { description: string }; matches: string[]; severity: string }> = [];

    if (Array.isArray(script?.patterns)) {
      for (const pattern of script.patterns) {
        if (!pattern?.regex) continue;

        try {
          const regex = new RegExp(pattern.regex, pattern.flags || 'gmi');
          const searchPaths: string[] = [];

          // Determine which files to scan
          if (Array.isArray(pattern.files)) {
            for (const filePattern of pattern.files) {
              const fullGlob = path.join(dir, filePattern);
              // Check if the file/directory exists
              if (fs.existsSync(fullGlob)) {
                searchPaths.push(fullGlob);
              }
            }
          }

          // Use grep-like search through files
          const matches: string[] = [];
          for (const searchPath of searchPaths) {
            try {
              const stats = fs.statSync(searchPath);
              if (stats.isDirectory()) {
                // Walk directory and grep files
                const grepResult = execSync(
                  `grep -rl --include="*.{yml,yaml,json,js,ts,properties,cfg,conf,txt,sh}" -E "${escapeRegex(pattern.regex)}" "${searchPath}" 2>/dev/null || true`,
                  { cwd: dir, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
                );
                const matchedFiles = grepResult.toString().split('\n').filter(Boolean);
                for (const f of matchedFiles) {
                  matches.push(f);
                }
              } else if (stats.isFile()) {
                const content = fs.readFileSync(searchPath, 'utf-8');
                if (regex.test(content)) {
                  matches.push(searchPath);
                }
              }
            } catch { /* skip unreadable files */ }
          }

          if (matches.length > 0) {
            results.push({
              pattern: { description: pattern.description || 'Unknown pattern' },
              matches,
              severity: pattern.severity || 'medium',
            });
          }
        } catch { /* skip invalid patterns */ }
      }
    }

    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to run radar scan', details: err.message });
  }
});

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Radar: Zip (for VirusTotal scan) ─────────────────────────────────────

app.post('/radar/zip', async (req, res) => {
  try {
    const { id, include, exclude, maxFileSizeMb } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const dir = dataDir(id);
    const maxSize = (maxFileSizeMb || 32) * 1024 * 1024;

    // Create a temporary zip file
    const tmpDir = path.join(DATA_DIR, 'tmp');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ok */ }

    const zipName = `vtscan-${id}-${Date.now()}.zip`;
    const zipPath = path.join(tmpDir, zipName);

    const includeDirs = Array.isArray(include) && include.length > 0 ? include : ['.'];
    const excludeDirs = Array.isArray(exclude) ? exclude : [];

    // Build find command to gather files, respecting size limits and exclusions
    const excludePatterns = excludeDirs.map(d => `-not -path '*/${d}/*'`).join(' ');
    const includePatterns = includeDirs.map(d => `-path '*/${d}/*' -o -name '${d}'`).join(' ');

    try {
      // First, collect the files to zip
      const findCmd = excludePatterns
        ? `find "${dir}" -type f ${excludePatterns} 2>/dev/null || true`
        : `find "${dir}" -type f 2>/dev/null || true`;

      const files = execSync(findCmd, { cwd: dir, timeout: 30000, maxBuffer: 50 * 1024 * 1024 })
        .toString().split('\n').filter(Boolean);

      // Filter by size and included directories
      const filteredFiles = files.filter(f => {
        // Check if file is in an included directory
        if (includeDirs.length > 0 && !includeDirs.includes('.')) {
          const relative = path.relative(dir, f);
          const topDir = relative.split(path.sep)[0];
          if (!includeDirs.includes(topDir)) return false;
        }
        // Check file size
        try {
          const stats = fs.statSync(f);
          if (stats.size > maxSize) return false;
        } catch { return false; }
        return true;
      });

      if (filteredFiles.length === 0) {
        // Create an empty zip
        execSync(`zip -r "${zipPath}" . -i '/dev/null' 2>/dev/null || zip "${zipPath}" -r --filesync /dev/null 2>/dev/null || echo '' > "${zipPath}"`, { timeout: 10000 });
      } else {
        // Write file list to temp and use zip
        const fileListPath = path.join(tmpDir, `filelist-${id}.txt`);
        fs.writeFileSync(fileListPath, filteredFiles.join('\n'));
        execSync(`zip -r "${zipPath}" -@ < "${fileListPath}" 2>/dev/null`, { cwd: dir, timeout: 120000, maxBuffer: 50 * 1024 * 1024 });

        // Cleanup file list
        try { fs.unlinkSync(fileListPath); } catch { /* ok */ }
      }
    } catch {
      // Fallback: use tar
      try {
        execSync(`tar -czf "${zipPath}" ${includeDirs.map(d => `"${d}"`).join(' ')} 2>/dev/null`, { cwd: dir, timeout: 120000 });
      } catch (tarErr: any) {
        return res.status(500).json({ error: 'Failed to create archive', details: (tarErr as Error).message });
      }
    }

    // Read the zip and send it
    if (!fs.existsSync(zipPath)) {
      return res.status(500).json({ error: 'Archive was not created' });
    }

    const stat = fs.statSync(zipPath);
    if (stat.size === 0) {
      // Send empty zip
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      return res.end(Buffer.from('PK\x05\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'binary'));
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(zipPath);
    readStream.pipe(res);

    readStream.on('end', () => {
      // Cleanup temp zip
      try { fs.unlinkSync(zipPath); } catch { /* ok */ }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create radar zip', details: err.message });
  }
});

// ── Minecraft: Player Query ───────────────────────────────────────────────

app.get('/minecraft/players', async (req, res) => {
  try {
    const id = req.query.id as string;
    const host = req.query.host as string;
    const port = parseInt(req.query.port as string, 10);

    if (!id || !host || !port) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Check if server is running via container status
    let containerRunning = false;
    try {
      if (await containerExists(id)) {
        const d = ensureDocker();
        const info = await d.getContainer(containerName(id)).inspect();
        containerRunning = info.State.Running;
      }
    } catch { /* assume not running */ }

    if (!containerRunning) {
      return res.json({
        online: false,
        players: [],
        maxPlayers: 0,
        onlinePlayers: 0,
        version: null,
      });
    }

    // Simple Minecraft server list ping (SRC query using net)
    try {
      const result = await pingMinecraftServer(host, port, 5000);
      res.json(result);
    } catch {
      res.json({
        online: false,
        players: [],
        maxPlayers: 0,
        onlinePlayers: 0,
        version: null,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to query players', details: err.message });
  }
});

// ── Minecraft ping helper ─────────────────────────────────────────────────

async function pingMinecraftServer(host: string, port: number, timeoutMs: number): Promise<{
  online: boolean;
  version: string | null;
  maxPlayers: number;
  onlinePlayers: number;
  players: Array<{ name: string; uuid: string }>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error('Timeout'));
      }
    }, timeoutMs);

    socket.connect(port, host, () => {
      // Minecraft 1.7+ Server List Ping
      const buf = createMinecraftPingPacket(host, port);
      socket.write(buf);
    });

    let data = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      try {
        const result = parseMinecraftPingResponse(data);
        if (result) {
          clearTimeout(timer);
          if (!resolved) {
            resolved = true;
            socket.destroy();
            resolve(result);
          }
        }
      } catch {
        // Need more data
      }
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        // Try to parse whatever data we got
        if (data.length > 0) {
          try {
            const result = parseMinecraftPingResponse(data);
            if (result) return resolve(result);
          } catch { /* failed */ }
        }
        reject(new Error('Connection closed'));
      }
    });
  });
}

function createMinecraftPingPacket(host: string, port: number): Buffer {
  // Packet ID: 0x00 (Handshake)
  // Protocol version: -1 (auto-negotiate)
  // Server address, port, next state: 1 (status)
  const packetId = Buffer.from([0x00]);
  const protocolVer = writeVarInt(-1);
  const serverAddr = Buffer.from(host, 'utf-8');
  const serverAddrLen = writeVarInt(serverAddr.length);
  const serverPort = Buffer.alloc(2);
  serverPort.writeUInt16BE(port);
  const nextState = writeVarInt(1);

  const data = Buffer.concat([packetId, protocolVer, serverAddrLen, serverAddr, serverPort, nextState]);
  const len = writeVarInt(data.length);

  // Followed by Request packet: 0x01 (packet ID 0x00 for status request)
  const requestPacket = Buffer.from([0x01, 0x00]); // length(1) + packetID(0)

  return Buffer.concat([len, data, requestPacket]);
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let temp = value & 0x7F;
    value >>>= 7;
    if (value !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function parseMinecraftPingResponse(data: Buffer): {
  online: boolean;
  version: string | null;
  maxPlayers: number;
  onlinePlayers: number;
  players: Array<{ name: string; uuid: string }>;
} | null {
  try {
    // Skip VarInt packet length and packet ID (0x00)
    let offset = 0;
    const _packetLen = readVarInt(data, offset);
    offset += _packetLen.bytes;
    const _packetId = readVarInt(data, offset);
    offset += _packetId.bytes;
    const jsonLen = readVarInt(data, offset);
    offset += jsonLen.bytes;
    const jsonStr = data.slice(offset, offset + jsonLen.value).toString('utf-8');

    const info = JSON.parse(jsonStr);

    return {
      online: true,
      version: info.version?.name || null,
      maxPlayers: info.players?.max || 0,
      onlinePlayers: info.players?.online || 0,
      players: Array.isArray(info.players?.sample)
        ? info.players.sample.map((p: any) => ({ name: p.name || 'Unknown', uuid: p.id || '' }))
        : [],
    };
  } catch {
    return null;
  }
}

function readVarInt(buf: Buffer, offset: number): { value: number; bytes: number } {
  let value = 0;
  let bytes = 0;
  let byte = 0;
  do {
    byte = buf[offset + bytes];
    value |= (byte & 0x7F) << (7 * bytes);
    bytes++;
    if (bytes > 5) break;
  } while (byte & 0x80);
  return { value, bytes };
}

// ── HTTP server ───────────────────────────────────────────────────────────

const serverPort = parseInt(config.port || '3002', 10);
const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

function wsAuth(ws: WsSocket, req: IncomingMessage): boolean {
  // Extract Basic auth from the Upgrade request
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;
  const creds = Buffer.from(auth.slice(6), 'base64').toString();
  const [, password] = creds.split(':');
  return password === config.key;
}

wss.on('connection', (ws, req) => {
  const url = req.url || '';
  const parts = url.split('/');
  const pathSegment = parts[1];
  const uuid = parts[2];

  if (!uuid) {
    ws.close(4000, 'Missing server ID');
    return;
  }

  // The panel sends auth as a JSON message after connecting,
  // not as HTTP Basic auth headers. Wait for the auth message.
  let authenticated = false;

  const authHandler = (msg: Buffer | string) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'auth' && data.args && data.args[0] === config.key) {
        authenticated = true;
        ws.removeListener('message', authHandler);
        ws.send(JSON.stringify({ event: 'auth success' }));

        // Route to the appropriate handler
        if (pathSegment === 'container') {
          handleConsoleWs(ws, uuid);
        } else if (pathSegment === 'containerstatus') {
          handleStatusWs(ws, uuid);
        } else if (pathSegment === 'containerevents') {
          handleEventsWs(ws, uuid);
        } else {
          ws.close(4000, 'Unknown endpoint');
        }
        return;
      }
    } catch { /* not JSON auth message */ }
    ws.close(4001, 'Unauthorized');
  };

  ws.on('message', authHandler);

  // Timeout: if auth not received within 10s, close
  setTimeout(() => {
    if (!authenticated && ws.readyState === ws.OPEN) {
      ws.removeListener('message', authHandler);
      ws.close(4001, 'Auth timeout');
    }
  }, 10000);
});

// ── WebSocket: Console ────────────────────────────────────────────────────

async function handleConsoleWs(ws: WsSocket, uuid: string) {
  try {
    const d = ensureDocker();
    const name = containerName(uuid);
    const container = d.getContainer(name);

    // Check container exists
    let running = false;
    try {
      const info = await container.inspect();
      running = info.State.Running;
    } catch {
      ws.send(JSON.stringify({ error: 'Container not found' }));
      ws.close();
      return;
    }

    if (!running) {
      ws.send(JSON.stringify({ error: 'Container is not running' }));
      ws.close();
      return;
    }

    // Attach to container
    const attachStream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
    });

    // Send auth success
    ws.send(JSON.stringify({ event: 'auth success' }));

    // Forward container output to WebSocket
    attachStream.on('data', (chunk: Buffer) => {
      const type = chunk[0];
      const data = chunk.slice(8).toString('utf-8');
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    attachStream.on('end', () => {
      if (ws.readyState === ws.OPEN) {
        ws.send('\x1b[31;1mContainer process ended.\x1b[0m\n');
        ws.close();
      }
    });

    attachStream.on('error', () => {
      if (ws.readyState === ws.OPEN) {
        ws.send('\x1b[31;1mConnection to container lost.\x1b[0m\n');
        ws.close();
      }
    });

    // Forward WebSocket messages to container stdin
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.event === 'auth' && data.args && data.args[0] === config.key) {
          ws.send(JSON.stringify({ event: 'auth success' }));
          return;
        }
      } catch { /* not JSON, treat as raw input */ }

      if (Buffer.isBuffer(msg)) {
        attachStream.write(msg);
      } else {
        attachStream.write(Buffer.from(msg.toString()));
      }
    });

    ws.on('close', () => {
      try { (attachStream as any).destroy(); } catch { /* ok */ }
    });
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ error: err.message }));
      ws.close();
    }
  }
}

// ── WebSocket: Status ─────────────────────────────────────────────────────

async function handleStatusWs(ws: WsSocket, uuid: string) {
  const interval = setInterval(async () => {
    try {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(interval);
        return;
      }

      const state = getInstallState(uuid);
      let running = false;
      let status = 'unknown';

      try {
        if (await containerExists(uuid)) {
          const d = ensureDocker();
          const info = await d.getContainer(containerName(uuid)).inspect();
          running = info.State.Running;
          status = info.State.Status;
        }
      } catch { /* container not found */ }

      ws.send(JSON.stringify({
        state,
        running,
        status,
        online: running,
      }));
    } catch {
      clearInterval(interval);
    }
  }, 3000);

  ws.on('close', () => clearInterval(interval));
}

// ── WebSocket: Events ─────────────────────────────────────────────────────

async function handleEventsWs(ws: WsSocket, uuid: string) {
  try {
    const d = ensureDocker();

    // Listen to Docker events for this container
    const eventStream = await d.getEvents({
      filters: {
        container: [containerName(uuid)],
        event: ['start', 'stop', 'die', 'destroy', 'kill', 'pause', 'unpause'],
      },
    });

    const eventBuffer: any[] = [];

    const eventHandler = (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString());
        eventBuffer.push(event);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      } catch { /* ignore malformed events */ }
    };

    eventStream.on('data', eventHandler);
    eventStream.on('error', () => { /* ignore */ });

    // Send initial status
    try {
      if (await containerExists(uuid)) {
        const info = await d.getContainer(containerName(uuid)).inspect();
        ws.send(JSON.stringify({ status: info.State.Status, running: info.State.Running }));
      }
    } catch { /* ok */ }

    ws.on('close', () => {
      try { (eventStream as any).destroy(); } catch { /* ok */ }
    });
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ error: err.message }));
      ws.close();
    }
  }
}

server.listen(serverPort, () => {
  console.log(`Sodium Daemon listening on port ${serverPort}`);
});
