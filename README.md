# JONImageProcessor-Gateway

Node.js gateway for the local `JONImageProcessor` runtime IPC API. The gateway exposes an authenticated HTTP JSON API, a WebSocket API, and file-management endpoints for media folders that are needed by the remote UI.

`JONImageProcessor` itself speaks NDJSON over a Unix domain socket, usually `/tmp/jonimageprocessor.sock`. This gateway validates incoming commands against a local JSON schema, forwards allowed IPC requests to that socket, and handles media upload/delete separately through configured working directories.

## Requirements

- Node.js 20 or newer. Node.js 22 is recommended.
- A running `JONImageProcessor` process with IPC enabled.
- The gateway user must have read/write access to the configured media folders and access to the Unix socket.
- npm project dependencies installed with `npm install`.

## Install

Default deployment layout:

```bash
/opt/JONImageProcessor-Gateway/bin/server.js
/opt/JONImageProcessor-Gateway/src/
/opt/JONImageProcessor-Gateway/public/
/opt/JONImageProcessor-Gateway/node_modules/
/opt/JONImageProcessor-Gateway/etc/gateway.config.json
/opt/JONImageProcessor-Gateway/etc/token.env
```

Install the application from a checkout on the target machine:

```bash
npm install --omit=dev
sudo install -d -m 755 /opt/JONImageProcessor-Gateway
sudo install -d -m 755 /opt/JONImageProcessor-Gateway/bin
sudo install -d -m 755 /opt/JONImageProcessor-Gateway/src
sudo install -d -m 755 /opt/JONImageProcessor-Gateway/public
sudo install -d -m 700 /opt/JONImageProcessor-Gateway/etc
sudo cp -a bin/. /opt/JONImageProcessor-Gateway/bin/
sudo cp -a src/. /opt/JONImageProcessor-Gateway/src/
sudo cp -a public/. /opt/JONImageProcessor-Gateway/public/
sudo cp -a node_modules package.json package-lock.json /opt/JONImageProcessor-Gateway/
sudo cp config/gateway.config.example.json /opt/JONImageProcessor-Gateway/etc/gateway.config.json
```

The files copied to `/opt/JONImageProcessor-Gateway/bin` and `/opt/JONImageProcessor-Gateway/src` are the gateway code. `public` contains the WebUI served by the same Node.js process. `node_modules`, `package.json`, and `package-lock.json` are copied so the installed service has the npm dependencies it needs at runtime.

Install the example systemd unit:

```bash
sudo cp packaging/systemd/jonimageprocessor-gateway.service /etc/systemd/system/jonimageprocessor-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable jonimageprocessor-gateway.service
```

Do not start the service until `/opt/JONImageProcessor-Gateway/etc/gateway.config.json` and `/opt/JONImageProcessor-Gateway/etc/token.env` have been configured.

## Configuration

Copy the example config and edit paths for the target system:

```bash
sudo nano /opt/JONImageProcessor-Gateway/etc/gateway.config.json
```

The important settings are:

- `server.host` / `server.port`: HTTP bind address.
- `server.corsAllowedOrigins`: optional list of browser origins allowed to call the API from another site. Use the future local WebUI from the same origin when possible.
- `jonImageProcessor.ipcSocket`: Unix socket exposed by `JONImageProcessor`.
- `jonImageProcessor.pollIntervalMs`: interval for polling `list` from the Unix socket and broadcasting state to WebUI clients over WebSocket.
- `files.roots`: named upload/delete roots, for example `backgrounds` and `pause`.
- `api.commands`: allowed `list`, `get`, and `set` IPC operations plus value validation for each writable key.

The config is also intended as the future WebUI schema. `/api/schema` returns the allowed API shape without secrets.

Media assets are uploaded as ZIP packages only. Each ZIP must contain exactly one top-level directory. That directory must contain an `info.json` file with:

```json
{
  "name": "Studio Background",
  "version": "1.0.0",
  "description": "Short description for the UI",
  "type": "Image",
  "startFile": "background.jpg"
}
```

Allowed `type` values are `Image`, `Video`, and `HTML App`. `startdatei` is accepted as an alias for `startFile`. The ZIP is unpacked into the configured root as its own asset directory, for example `/opt/JONImageProcessor/backgrounds/studio-background/info.json`.

A complete image asset example is available in `examples/assets/sample-background/`. See `examples/README.md` for ZIP and upload commands.

## Authentication

The gateway requires a token at startup. The easiest setup is an environment file:

```bash
sudo install -m 700 -d /opt/JONImageProcessor-Gateway/etc
printf 'JON_GATEWAY_TOKEN=%s\n' "$(openssl rand -base64 32)" | sudo tee /opt/JONImageProcessor-Gateway/etc/token.env >/dev/null
sudo chmod 600 /opt/JONImageProcessor-Gateway/etc/token.env
```

Clients send the token as:

```http
Authorization: Bearer <token>
```

`X-API-Token: <token>` also works. Query tokens are enabled by default for browser WebSocket clients:

```text
ws://host:8080/api/ws?token=<token>
```

For deployments where the token should not be stored as plaintext in an environment file, put SHA-256 hashes into `auth.tokenSha256` in the config.

## Run Locally

```bash
JON_GATEWAY_TOKEN=dev-token node bin/server.js
```

Use a different config path when needed:

```bash
JON_GATEWAY_CONFIG=/opt/JONImageProcessor-Gateway/etc/gateway.config.json JON_GATEWAY_TOKEN=dev-token node bin/server.js
```

Syntax check:

```bash
npm install
npm run check
```

## HTTP API

The WebUI is served by the gateway at:

```text
http://127.0.0.1:8080/
```

The UI stores the API token in browser local storage and uses the same HTTP JSON API documented below.

The gateway also polls the `JONImageProcessor` Unix socket regularly and broadcasts state updates to the WebUI through `/api/ws`. After the UI sends a setting change, the gateway triggers an additional poll. The UI keeps the changed control in a pending state until the polled server state confirms it; if confirmation times out, the control rolls back to the previous value. The browser-side confirmation timeout is configurable in the WebUI settings dialog.

Health is intentionally unauthenticated:

```bash
curl http://127.0.0.1:8080/api/health
```

Read the public schema:

```bash
curl -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  http://127.0.0.1:8080/api/schema
```

Forward a validated IPC request:

```bash
curl -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"get","key":"segmentation.threshold"}' \
  http://127.0.0.1:8080/api/ipc
```

Set a runtime value:

```bash
curl -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"set","key":"background.effect","value":"blur"}' \
  http://127.0.0.1:8080/api/ipc
```

List uploaded assets in a configured root. The response contains metadata from `info.json`, not raw file names:

```bash
curl -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  http://127.0.0.1:8080/api/files/backgrounds
```

Upload a ZIP asset package with raw HTTP `PUT` or `POST`. `POST` is accepted because `curl --data-binary` uses `POST` unless `-X PUT` is specified:

```bash
curl -X PUT -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  --data-binary @studio-background.zip \
  http://127.0.0.1:8080/api/files/backgrounds/studio-background.zip
```

Equivalent `POST` upload:

```bash
curl -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  --data-binary @studio-background.zip \
  http://127.0.0.1:8080/api/files/backgrounds/studio-background.zip
```

Delete an asset directory:

```bash
curl -X DELETE -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  http://127.0.0.1:8080/api/files/backgrounds/studio-background
```

When a client sets `background.image` or `pause.image`, it sends the asset id, for example `studio-background`. The gateway reads that asset's `info.json`, resolves `startFile`, and forwards the relative package path such as `studio-background/background.jpg` to the `JONImageProcessor` Unix socket API.

## WebSocket API

Connect to:

```text
ws://127.0.0.1:8080/api/ws?token=<token>
```

Each text message is the same JSON object accepted by `POST /api/ipc`, for example:

```json
{"cmd":"list"}
```

Responses are the JSON responses from `JONImageProcessor`, or a gateway validation error.

## systemd

Install the application under `/opt/JONImageProcessor-Gateway`, configure `/opt/JONImageProcessor-Gateway/etc/gateway.config.json`, and create `/opt/JONImageProcessor-Gateway/etc/token.env` as shown above.

Example systemd unit:

```ini
[Unit]
Description=JONImageProcessor Gateway
After=local-fs.target network-online.target jon-image-processor.service
Wants=network-online.target
Requires=jon-image-processor.service

[Service]
Type=simple
WorkingDirectory=/opt/JONImageProcessor-Gateway
Environment=JON_GATEWAY_CONFIG=/opt/JONImageProcessor-Gateway/etc/gateway.config.json
EnvironmentFile=-/opt/JONImageProcessor-Gateway/etc/token.env
ExecStart=/usr/bin/node /opt/JONImageProcessor-Gateway/bin/server.js
Restart=always
RestartSec=2
User=jonimageprocessor
Group=jonimageprocessor
SupplementaryGroups=video input render debug

[Install]
WantedBy=jon.target
```

Start or restart the service:

```bash
sudo systemctl start jonimageprocessor-gateway.service
```

Inspect logs:

```bash
journalctl -u jonimageprocessor-gateway.service -f
```

The gateway writes JSON log records with systemd/journald priority prefixes. Failed requests include method, path, status, remote address, duration, and the error message. For recent errors:

```bash
journalctl -u jonimageprocessor-gateway.service -p warning -n 100 --no-pager
```

If the Unix socket is owned by another user or group, adjust the `User=`, `Group=`, or supplementary groups in the unit so the gateway can connect to it.
