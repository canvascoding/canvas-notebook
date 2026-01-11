# Cloudflare DNS Setup für Canvas Notebook

**Domain:** `chat.canvasstudios.store`
**Server:** ssh.canvas.holdings (3.66.71.254)
**App Port:** 3001

---

## 🌐 Problem: Port 3001 und Cloudflare

**Cloudflare Proxy unterstützt nur bestimmte Ports:**
- HTTP: 80, 8080, 8880, 2052, 2082, 2086, 2095
- HTTPS: 443, 2053, 2083, 2087, 2096, 8443

❌ **Port 3001 wird NICHT unterstützt!**

## ✅ Lösung: Reverse Proxy

Wir brauchen einen **Reverse Proxy** (Nginx oder Caddy) auf dem Server, der:
- Port 80/443 nach außen öffnet
- Intern zu `localhost:3001` weiterleitet
- SSL/TLS automatisch handhabt

---

## 📋 Setup-Anleitung

### Option A: Mit Nginx (Empfohlen) ⭐

#### 1. Cloudflare DNS Setup

Gehe zu Cloudflare Dashboard → DNS:

```
Typ: A
Name: chat
Content: 3.66.71.254
Proxy: ✅ Proxied (Orange Cloud)
TTL: Auto
```

**Wichtig:**
- ✅ **Proxy aktiviert** (orange cloud) für DDoS-Schutz und SSL
- Name ist nur `chat` (nicht die komplette Domain)
- Keine Port-Angabe im DNS-Record!

#### 2. Nginx auf Server installieren

SSH auf den Server:
```bash
ssh ubuntu@ssh.canvas.holdings

# Nginx installieren
sudo apt update
sudo apt install nginx -y

# Status prüfen
sudo systemctl status nginx
```

#### 3. Nginx Config erstellen

```bash
sudo nano /etc/nginx/sites-available/canvas-notebook
```

Folgende Config einfügen:

```nginx
# Canvas Notebook - chat.canvasstudios.store
server {
    listen 80;
    listen [::]:80;
    server_name chat.canvasstudios.store;

    # Security Headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Client Body Size (für File Uploads)
    client_max_body_size 50M;

    # Reverse Proxy zu Next.js App
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;

        # WebSocket Support (für Terminal)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # Forwarded Headers
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Health Check Endpoint
    location /health {
        access_log off;
        return 200 "OK\n";
        add_header Content-Type text/plain;
    }
}
```

#### 4. Nginx Config aktivieren

```bash
# Symlink erstellen
sudo ln -s /etc/nginx/sites-available/canvas-notebook /etc/nginx/sites-enabled/

# Default Site deaktivieren (optional)
sudo rm /etc/nginx/sites-enabled/default

# Config testen
sudo nginx -t

# Nginx neustarten
sudo systemctl restart nginx

# Autostart aktivieren
sudo systemctl enable nginx
```

#### 5. Cloudflare SSL/TLS Einstellungen

In Cloudflare Dashboard → SSL/TLS:

```
SSL/TLS Encryption Mode: Full (nicht Strict)
Edge Certificates: ✅ Always Use HTTPS
Minimum TLS Version: 1.2
```

**Warum "Full" und nicht "Strict"?**
- "Full" = Cloudflare ↔ Server verschlüsselt, aber akzeptiert self-signed cert
- "Strict" = Benötigt valides CA-signiertes Zertifikat
- Wir nutzen erstmal "Full", dann upgraden mit Let's Encrypt

#### 6. Canvas Notebook für Production konfigurieren

`.env.local` auf dem Server:

```bash
# Production Mode
NODE_ENV=production

# Public URL
NEXT_PUBLIC_APP_URL=https://chat.canvasstudios.store

# WebSocket URL (über Cloudflare)
NEXT_PUBLIC_WS_URL=wss://chat.canvasstudios.store

# Session Cookies (HTTPS only)
SESSION_SECURE_COOKIES=true

# SSH Configuration
SSH_HOST=localhost
SSH_PORT=22
SSH_USER=canvas-notebook
SSH_KEY_PATH=/home/ubuntu/.ssh/canvas-key

# Strong credentials (generiert mit scripts/)
APP_USERNAME=admin
APP_PASSWORD_HASH=<bcrypt_hash>
SESSION_SECRET=<32_byte_random>
```

#### 7. App mit PM2 starten

```bash
cd "/home/ubuntu/webapp canvasstudios/canvas-notebook"

# Dependencies installieren
npm install

# Production Build
npm run build

# PM2 installieren (falls noch nicht)
npm install -g pm2

# App starten
PORT=3001 pm2 start npm --name "canvas-notebook" -- start

# Logs ansehen
pm2 logs canvas-notebook

# Autostart aktivieren
pm2 startup
pm2 save
```

#### 8. Testen

```bash
# DNS propagation prüfen (von deinem lokalen PC)
nslookup chat.canvasstudios.store

# HTTP Test
curl -I http://chat.canvasstudios.store

# HTTPS Test (über Cloudflare)
curl -I https://chat.canvasstudios.store

# Im Browser öffnen
https://chat.canvasstudios.store
```

---

### Option B: Mit Caddy (Einfacher, automatisches SSL)

Falls du Caddy bevorzugst (einfacherer Setup):

#### 1. Caddy installieren

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

#### 2. Caddy Config

```bash
sudo nano /etc/caddy/Caddyfile
```

```caddy
chat.canvasstudios.store {
    reverse_proxy localhost:3001 {
        # WebSocket Support
        header_up Upgrade {>Upgrade}
        header_up Connection {>Connection}
    }

    # Security Headers
    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # File Upload Limit
    request_body {
        max_size 50MB
    }
}
```

#### 3. Caddy starten

```bash
sudo systemctl restart caddy
sudo systemctl enable caddy
```

**Vorteil Caddy:**
- ✅ Automatisches SSL mit Let's Encrypt
- ✅ Einfachere Konfiguration
- ✅ Automatic HTTPS

---

### Option C: Cloudflare Tunnel (Ohne Reverse Proxy)

Falls du keinen Reverse Proxy willst:

#### 1. Cloudflared installieren

```bash
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

#### 2. Tunnel erstellen

```bash
cloudflared tunnel login
cloudflared tunnel create canvas-notebook
cloudflared tunnel route dns canvas-notebook chat.canvasstudios.store
```

#### 3. Config erstellen

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

```yaml
tunnel: <tunnel-id>
credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: chat.canvasstudios.store
    service: http://localhost:3001
  - service: http_status:404
```

#### 4. Tunnel starten

```bash
cloudflared tunnel run canvas-notebook
```

**Vorteil:**
- ✅ Kein Nginx/Caddy nötig
- ✅ Kein Port 80/443 öffnen
- ✅ Automatisches SSL
- ✅ Zero Trust Security

**Nachteil:**
- Zusätzlicher Service (cloudflared)
- Cloudflare-abhängig

---

## 🔒 Production Security Checklist

Nach dem Setup:

```bash
# Firewall konfigurieren
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw enable

# Port 3001 NICHT öffnen (nur localhost)
# App ist nur über Reverse Proxy erreichbar

# Fail2ban für SSH installieren
sudo apt install fail2ban -y
sudo systemctl enable fail2ban

# Automatische Updates aktivieren
sudo apt install unattended-upgrades -y
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 📊 Vergleich der Optionen

| Feature | Nginx | Caddy | Cloudflare Tunnel |
|---------|-------|-------|-------------------|
| **Setup-Komplexität** | Mittel | Einfach | Mittel |
| **Automatisches SSL** | ❌ (manuell) | ✅ | ✅ |
| **Performance** | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ |
| **WebSocket Support** | ✅ | ✅ | ✅ |
| **Flexibilität** | ⭐⭐⭐ | ⭐⭐ | ⭐ |
| **Ports öffnen** | 80, 443 | 80, 443 | Keine |
| **Empfohlen für** | Production | Schnellstart | Zero Trust |

---

## 🆘 Troubleshooting

### DNS propagiert nicht

```bash
# DNS Cache leeren (lokal)
ipconfig /flushdns  # Windows
sudo dscacheutil -flushcache  # macOS

# Cloudflare DNS prüfen
dig @1.1.1.1 chat.canvasstudios.store
```

### 502 Bad Gateway

```bash
# Canvas Notebook läuft nicht
pm2 status
pm2 restart canvas-notebook

# Port 3001 nicht erreichbar
netstat -tulpn | grep 3001
lsof -i :3001
```

### SSL-Fehler

```bash
# Cloudflare SSL Mode prüfen (muss "Full" sein)
# Nginx Logs:
sudo tail -f /var/log/nginx/error.log

# Caddy Logs:
sudo journalctl -u caddy -f
```

### WebSocket-Verbindung schlägt fehl

```bash
# Nginx: Upgrade Header prüfen
# Cloudflare: WebSocket aktiviert? (Standard: ja)

# Test:
wscat -c wss://chat.canvasstudios.store/api/terminal/test
```

---

## 📚 Weitere Ressourcen

- [Nginx Reverse Proxy Guide](https://www.nginx.com/resources/wiki/start/topics/examples/reverseproxycachingexample/)
- [Caddy Reverse Proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [Canvas Notebook Security Guide](./SECURITY.md)

---

## ✅ Empfohlenes Setup

Für **Production** empfehle ich:

1. **Cloudflare DNS:** A Record mit Proxy (orange cloud)
2. **Nginx Reverse Proxy:** Port 80/443 → localhost:3001
3. **Let's Encrypt SSL:** Kostenlos, automatisch erneuert
4. **PM2 Process Manager:** Für App-Verwaltung
5. **UFW Firewall:** Nur 22, 80, 443 offen

Das ist am stabilsten und produktionsreif! 🚀
