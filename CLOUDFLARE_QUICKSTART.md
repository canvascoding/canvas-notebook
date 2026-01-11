# Cloudflare Setup - AKTUELLER STATUS

**Domain:** chat.canvasstudios.store
**Server:** ssh.canvas.holdings (3.66.71.254)
**App Port:** 3001
**Status:** ✅ **DEPLOYED & LIVE**

---

## ✅ Was bereits erledigt ist

### 1. Cloudflare DNS ✅
```
Type: A
Name: chat
IPv4: 3.66.71.254
Proxy: ✅ Proxied (Orange Cloud)
```

### 2. Traefik Reverse Proxy ✅
```
Config: /etc/easypanel/traefik/config/canvas-notebook.json
Port 80/443 → localhost:3001
Status: Läuft
```

### 3. Canvas Notebook App ✅
```
Process Manager: PM2
Status: Online
Port: 3001
Autostart: Aktiviert
```

### 4. Credentials ✅
```
Username: admin
Password: 7b&BIfeGW)a[3!AKCOKJ
SSH User: canvas-notebook
```

---

## ⚠️ LETZTER SCHRITT: Cloudflare SSL/TLS Mode

### Problem
Du bekommst aktuell **HTTP 522 Error**, weil Cloudflare den falschen SSL-Modus hat.

### Lösung

Gehe zu **Cloudflare Dashboard** → **SSL/TLS** → **Overview**:

Setze den **Encryption Mode** auf:
```
Full (nicht Full strict)
```

**Warum?**
- ✅ "Full" = Cloudflare akzeptiert self-signed Zertifikate
- ❌ "Full (strict)" = Cloudflare braucht valides CA-Zertifikat (haben wir nicht)
- Traefik nutzt Easypanel's default Zertifikat

**Weitere Einstellungen:**
```
Always Use HTTPS: ✅ On
Minimum TLS Version: 1.2
Automatic HTTPS Rewrites: ✅ On
```

---

## 🧪 Nach der Änderung testen

```bash
# Von deinem lokalen PC
curl -I https://chat.canvasstudios.store

# Sollte zeigen:
# HTTP/2 200 OK (statt 522)
```

**Im Browser öffnen:**
```
https://chat.canvasstudios.store
```

**Login:**
- Username: `admin`
- Password: `7b&BIfeGW)a[3!AKCOKJ`

---

## 📊 Setup-Übersicht

```
Browser
  ↓
Cloudflare (SSL/TLS Termination + Proxy)
  ↓ HTTPS
Server (3.66.71.254)
  ↓ Port 443
Traefik (Reverse Proxy)
  ↓ Port 3001
Canvas Notebook (Next.js App)
  ↓ SSH
ssh.canvas.holdings
```

---

## 🔧 Wartung & Commands

### PM2 Commands
```bash
# Status prüfen
pm2 status

# Logs ansehen
pm2 logs canvas-notebook

# App neustarten
pm2 restart canvas-notebook

# Stop
pm2 stop canvas-notebook

# Start
pm2 start canvas-notebook
```

### Traefik Commands
```bash
# Config prüfen
cat /etc/easypanel/traefik/config/canvas-notebook.json

# Traefik neu laden (bei Config-Änderungen)
sudo docker service update --force traefik

# Logs ansehen
sudo docker logs traefik.1.yn0g68t1kufihstc5een2jnkg --tail 100
```

### App Deployment
```bash
cd "/home/ubuntu/webapp canvasstudios/canvas-notebook"

# Code pullen (z.B. von Git)
# git pull origin main

# Dependencies installieren
npm install

# Build
npm run build

# PM2 restart
pm2 restart canvas-notebook

# Logs prüfen
pm2 logs canvas-notebook
```

---

## 🐛 Troubleshooting

### 502 Bad Gateway
```bash
# App läuft nicht
pm2 status
pm2 restart canvas-notebook

# Port 3001 nicht erreichbar
lsof -i :3001
```

### 522 Connection Timeout
```bash
# Cloudflare SSL Mode falsch
→ Setze auf "Full" (nicht "Full strict")

# App läuft nicht
pm2 status

# Traefik Config falsch
cat /etc/easypanel/traefik/config/canvas-notebook.json
sudo docker service update --force traefik
```

### Login funktioniert nicht
```bash
# Credentials prüfen
cat /home/ubuntu/webapp\ canvasstudios/canvas-notebook/.env.local | grep APP_

# Sollte zeigen:
# APP_USERNAME=admin
# APP_PASSWORD_HASH=$2b$10$WhVaZ2qvrscxhfhXD.Jb/.3G05p5D5LGCUNnlFHHAjGKPN3BcqteW
```

### SSL-Zertifikat Fehler
```bash
# Cloudflare SSL Mode prüfen
→ Muss "Full" sein (nicht "Full strict")

# Traefik Logs prüfen
sudo docker logs traefik.1.yn0g68t1kufihstc5een2jnkg | grep -i cert
```

---

## 📚 Weitere Dokumentation

- **[README.md](README.md)** - Projekt-Übersicht
- **[docs/SECURITY.md](docs/SECURITY.md)** - Security Guide
- **[docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md)** - Detailliertes Setup
- **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** - Implementierungs-Status

---

## ✅ Production Checklist

Nach SSL-Mode Änderung sollte alles funktionieren:

```bash
✅ DNS: chat.canvasstudios.store → 3.66.71.254
✅ Cloudflare Proxy: Orange Cloud aktiv
✅ Cloudflare SSL: Full Mode
✅ Traefik: Läuft & konfiguriert
✅ Canvas Notebook: PM2 online
✅ Port 3001: Erreichbar
✅ Credentials: Stark & gesetzt
✅ HTTPS: Funktioniert nach SSL-Mode Änderung
```

---

**Letzte Aktualisierung:** 7. Januar 2026
**Status:** Production-ready (nach SSL Mode Änderung)
