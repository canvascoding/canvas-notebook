# Monitoring

## Process Manager
Use systemd or pm2 to keep the server running and restart on failure.

Example with pm2:

```bash
npm install -g pm2
pm2 start server.js --name canvas-notebook
pm2 save
```

## Basic Health Check
You can monitor `/api/files/tree?path=.&depth=1` (authenticated) or use a custom ping endpoint if needed.

## Logs
- stdout/stderr from `server.js`
- reverse proxy logs (Nginx/Apache)

## Alerts
Recommended signals:
- process restarts
- 5xx rate spikes
- latency thresholds for `/api/files/*`
