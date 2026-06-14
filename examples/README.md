# Example Assets

`assets/sample-background/` is a complete example asset directory. It can be used as a background or pause asset because it contains:

- `info.json`
- `sample_background.jpg`

Build an upload ZIP from this directory:

```bash
cd examples/assets
zip -r sample-background.zip sample-background
```

Upload it as a background:

```bash
curl -X PUT -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  --data-binary @sample-background.zip \
  http://127.0.0.1:8080/api/files/backgrounds/sample-background.zip
```

Upload it as a pause image:

```bash
curl -X PUT -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  --data-binary @sample-background.zip \
  http://127.0.0.1:8080/api/files/pause/sample-background.zip
```

Select it through the gateway API:

```bash
curl -H "Authorization: Bearer $JON_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"set","key":"background.image","value":"sample-background"}' \
  http://127.0.0.1:8080/api/ipc
```
