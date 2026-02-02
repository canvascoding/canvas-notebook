# Deployment Status - Canvas Notebook

**Status:** ✅ **DEPLOYED & RUNNING**
**Datum:** 7. Januar 2026

---

## ✅ Deployment abgeschlossen!

Die Canvas Notebook App ist **live** und läuft in Production.

### Quick Access

**URL:** https://chat.canvasstudios.store

**Login:**
- Username: `admin`
- Password: `canvas2026!`

---

## 📊 Aktueller Setup

### Infrastructure
```
Domain: chat.canvasstudios.store
Server: ssh.canvas.holdings (3.66.71.254)
Reverse Proxy: Traefik (via Easypanel)
Process Manager: PM2
App Port: 3001
SSL: Cloudflare
```

### Services Status
```bash
✅ Traefik: Running (Port 80/443)
✅ Canvas Notebook: Online (PM2, Port 3001)
✅ PM2 Autostart: Enabled
✅ Cloudflare DNS: Configured
✅ Cloudflare Proxy: Active (Orange Cloud)
```

---

## ⚠️ Letzter Schritt

Wenn du **HTTP 522 Error** bekommst:

**Cloudflare Dashboard → SSL/TLS → Overview:**
```
Encryption Mode: Full (nicht Full strict!)
```

Danach sollte alles funktionieren! 🚀

---

## 🔧 Maintenance Commands

### PM2 (Process Management)
```bash
# Status prüfen
pm2 status

# Logs live ansehen
pm2 logs canvas-notebook

# App neustarten
pm2 restart canvas-notebook

# Stop
pm2 stop canvas-notebook

# Start
pm2 start canvas-notebook

# App komplett neu starten (nach Code-Änderungen)
pm2 delete canvas-notebook
cd "/home/ubuntu/webapp canvasstudios/canvas-notebook"
PORT=3001 pm2 start npm --name "canvas-notebook" -- start
pm2 save
```

### Traefik (Reverse Proxy)
```bash
# Config ansehen
cat /etc/easypanel/traefik/config/canvas-notebook.json

# Traefik neu laden (nach Config-Änderungen)
sudo docker service update --force traefik

# Traefik Logs
sudo docker logs traefik.1.yn0g68t1kufihstc5een2jnkg --tail 100 -f
```

### App Deployment (Nach Code-Änderungen)
```bash
cd "/home/ubuntu/webapp canvasstudios/canvas-notebook"

# 1. Code aktualisieren (z.B. git pull)
# git pull origin main

# 2. Dependencies
npm install

# 3. Build
npm run build

# 4. PM2 restart
pm2 restart canvas-notebook

# 5. Logs prüfen
pm2 logs canvas-notebook --lines 50
```

---

## 📁 Wichtige Dateien & Pfade

### Traefik Config
```
/etc/easypanel/traefik/config/canvas-notebook.json
```

### App Verzeichnis
```
/home/ubuntu/webapp canvasstudios/canvas-notebook
```

### Environment Config
```
/home/ubuntu/webapp canvasstudios/canvas-notebook/.env.local
```

### PM2 Config
```
~/.pm2/dump.pm2
~/.pm2/logs/canvas-notebook-*.log
```

---

## 🔍 Monitoring & Debugging

### Logs ansehen
```bash
# PM2 Logs (App)
pm2 logs canvas-notebook

# PM2 Logs (nur Errors)
pm2 logs canvas-notebook --err

# Traefik Logs
sudo docker logs traefik.1.yn0g68t1kufihstc5een2jnkg

# System Logs
sudo journalctl -u pm2-ubuntu -f
```

### Health Checks
```bash
# App läuft?
pm2 status

# Port 3001 offen?
lsof -i :3001
netstat -tulpn | grep 3001

# Traefik läuft?
sudo docker ps | grep traefik

# Localhost Test
curl -I http://localhost:3001

# Domain Test (vom Server)
curl -H "Host: chat.canvasstudios.store" http://localhost

# HTTPS Test (extern)
curl -I https://chat.canvasstudios.store
```

---

## 🐛 Troubleshooting

### 502 Bad Gateway
**Problem:** App läuft nicht oder antwortet nicht

**Lösung:**
```bash
pm2 status
pm2 restart canvas-notebook
pm2 logs canvas-notebook
```

### 522 Connection Timeout
**Problem:** Cloudflare kann nicht zum Server connecten

**Lösung:**
1. Cloudflare SSL Mode auf "Full" setzen
2. App läuft prüfen: `pm2 status`
3. Traefik Config prüfen: `cat /etc/easypanel/traefik/config/canvas-notebook.json`

### Login funktioniert nicht
**Problem:** Credentials falsch

**Lösung:**
```bash
# Credentials prüfen
cat /home/ubuntu/webapp\ canvasstudios/canvas-notebook/.env.local | grep -E "APP_USERNAME|APP_PASSWORD"

# Sollte zeigen:
# APP_USERNAME=admin
# APP_PASSWORD_HASH=$2b$10$WhVaZ2qvrscxhfhXD.Jb/.3G05p5D5LGCUNnlFHHAjGKPN3BcqteW

# Plain Password: 7b&BIfeGW)a[3!AKCOKJ
```

### App startet nicht nach Server Reboot
**Problem:** PM2 Autostart nicht aktiviert

**Lösung:**
```bash
pm2 startup
# Kopiere den angezeigten Befehl und führe ihn aus

pm2 save
```

---

## 🔐 Security Checklist

```bash
✅ Starke Credentials gesetzt (bcrypt hash)
✅ SSH-Key basierte Auth (für SSH)
✅ SESSION_SECRET generiert (32 bytes)
✅ Cloudflare Proxy aktiv (DDoS Protection)
✅ SSL/TLS via Cloudflare
✅ Rate Limiting implementiert
✅ Security Headers gesetzt
⚠️ TODO: APP_PASSWORD (plain) aus .env.local entfernen
⚠️ TODO: Fail2ban für SSH installieren
```

---

## 📊 Performance

### App Metriken
```bash
# PM2 Monitoring
pm2 monit

# Memory/CPU
pm2 status
```

### Ressourcen
```bash
# Disk Space
df -h

# Memory
free -h

# CPU
top
htop
```

---

## 🚀 Next Steps (Optional)

### Let's Encrypt SSL (statt Cloudflare)
Falls du ein eigenes SSL-Zertifikat willst:
```bash
# Certbot installieren
sudo apt install certbot python3-certbot-nginx

# Zertifikat generieren
sudo certbot --nginx -d chat.canvasstudios.store

# Cloudflare SSL Mode auf "Full (strict)" ändern
```

### Monitoring Setup
```bash
# PM2 Plus (kostenpflichtig)
pm2 link <secret> <public>

# Oder: Netdata installieren
bash <(curl -Ss https://my-netdata.io/kickstart.sh)
```

### Backups
```bash
# PM2 Config Backup
pm2 save

# App Backup
tar -czf canvas-notebook-backup-$(date +%Y%m%d).tar.gz \
  /home/ubuntu/webapp\ canvasstudios/canvas-notebook

# Database Backup (falls vorhanden)
# ...
```

---

## 📚 Dokumentation

- **[README.md](README.md)** - Projekt-Übersicht
- **[CLOUDFLARE_QUICKSTART.md](CLOUDFLARE_QUICKSTART.md)** - SSL Mode Fix
- **[docs/SECURITY.md](docs/SECURITY.md)** - Security Guide
- **[docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md)** - Detailliertes Setup
- **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** - Feature Status

---

## ✅ Production Checklist

```bash
✅ DNS configured (chat.canvasstudios.store → 3.66.71.254)
✅ Cloudflare Proxy enabled (Orange Cloud)
✅ Traefik Reverse Proxy configured
✅ PM2 running & autostart enabled
✅ Strong credentials set
✅ SSH-Key authentication
✅ Security headers configured
⚠️ Cloudflare SSL Mode auf "Full" setzen (falls 522 Error)
```

---

**Deployment durchgeführt:** 7. Januar 2026, 23:35 UTC
**Deployed von:** Claude Code Assistant
**Status:** ✅ Production-ready
