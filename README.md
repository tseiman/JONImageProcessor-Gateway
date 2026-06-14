# JONImageProcessor-Gateway

Node.js gateway for the local `JONImageProcessor` runtime IPC API. The gateway exposes an authenticated HTTP JSON API, a WebSocket API, and file-management endpoints for media folders that are needed by the remote UI.

`JONImageProcessor` itself speaks NDJSON over a Unix domain socket, usually `/tmp/jonimageprocessor.sock`. This gateway validates incoming commands against a local JSON schema, forwards allowed IPC requests to that socket, and handles media upload/delete separately through configured working directories.

## Requirements

- Node.js 20 or newer. Node.js 22 is recommended.
- A running `JONImageProcessor` process with IPC enabled.
- The gateway user must have read/write access to the configured media folders and access to the Unix socket.
- npm project dependencies installed with `npm install`.

## Configuration

Copy the example config and edit paths for the target system:

```bash
sudo mkdir -p /etc/jonimageprocessor-gateway
sudo cp config/gateway.config.example.json /etc/jonimageprocessor-gateway/config.json
sudo nano /etc/jonimageprocessor-gateway/config.json
```

The important settings are:

- `server.host` / `server.port`: HTTP bind address.
- `server.corsAllowedOrigins`: optional list of browser origins allowed to call the API from another site. Use the future local WebUI from the same origin when possible.
- `jonImageProcessor.ipcSocket`: Unix socket exposed by `JONImageProcessor`.
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

## Authentication

The gateway requires a token at startup. The easiest setup is an environment file:

```bash
sudo install -m 700 -d /etc/jonimageprocessor-gateway
printf 'JON_GATEWAY_TOKEN=%s\n' "$(openssl rand -base64 32)" | sudo tee /etc/jonimageprocessor-gateway/token.env >/dev/null
sudo chmod 600 /etc/jonimageprocessor-gateway/token.env
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
JON_GATEWAY_TOKEN=dev-token node src/server.js
```

Use a different config path when needed:

```bash
JON_GATEWAY_CONFIG=/etc/jonimageprocessor-gateway/config.json JON_GATEWAY_TOKEN=dev-token node src/server.js
```

Syntax check:

```bash
npm install
npm run check
```

## HTTP API

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

Upload a ZIP asset package with raw HTTP `PUT`:

```bash
curl -X PUT -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
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

Install the application under `/opt/JONImageProcessor-Gateway`, configure `/etc/jonimageprocessor-gateway/config.json`, and create `/etc/jonimageprocessor-gateway/token.env` as shown above.

Install dependencies from the project directory:

```bash
npm install --omit=dev
```

Copy and enable the unit:

```bash
sudo cp packaging/systemd/jonimageprocessor-gateway.service /etc/systemd/system/jonimageprocessor-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable jonimageprocessor-gateway.service
sudo systemctl start jonimageprocessor-gateway.service
```

Inspect logs:

```bash
journalctl -u jonimageprocessor-gateway.service -f
```

If the Unix socket is owned by another user or group, adjust the `User=`, `Group=`, or supplementary groups in the unit so the gateway can connect to it.
