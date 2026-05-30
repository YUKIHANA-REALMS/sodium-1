# Sodium Daemon

The daemon component of Sodium Panel. It runs on game server nodes and communicates with the panel.

## Installation

The daemon is installed automatically when you run the main installer:

```bash
bash <(curl -s https://raw.githubusercontent.com/sodium/panel/main/install.sh)
```

Or for daemon-only installation:

```bash
bash <(curl -s https://raw.githubusercontent.com/sodium/panel/main/install.sh) --daemon-only
```

## Structure

- `src/` — Daemon source code
- Configuration is stored in `/etc/sodium-daemon/.env`

## Powered by IndiCloud

Sodium is powered by IndiCloud — https://www.indicloud.xyz
