#!/bin/bash
# Canvas Notebook - Production Deployment Script
# Richtet Nginx Reverse Proxy + PM2 ein

set -e

# Farben
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Canvas Notebook - Production Deployment      ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo ""

# Config
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="chat.canvasstudios.store"
APP_PORT="3000"

echo -e "${YELLOW}Projekt-Verzeichnis: ${PROJECT_DIR}${NC}"
echo -e "${YELLOW}Domain: ${DOMAIN}${NC}"
echo -e "${YELLOW}App Port: ${APP_PORT}${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
   echo -e "${RED}❌ Bitte NICHT als root ausführen!${NC}"
   echo "Verwende: ./scripts/deploy-production.sh"
   exit 1
fi

# 1. System Update
echo -e "${GREEN}📦 System aktualisieren...${NC}"
sudo apt update
sudo apt upgrade -y

# 2. Node.js prüfen
echo ""
echo -e "${GREEN}🔍 Node.js Version prüfen...${NC}"
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}❌ Node.js >= 20 erforderlich (aktuell: v${NODE_VERSION})${NC}"
    echo "Installiere Node.js 20 mit nvm oder apt"
    exit 1
fi
echo -e "${GREEN}✅ Node.js $(node -v) OK${NC}"

# 3. Nginx installieren
echo ""
echo -e "${GREEN}🌐 Nginx installieren...${NC}"
if ! command -v nginx &> /dev/null; then
    sudo apt install -y nginx
    echo -e "${GREEN}✅ Nginx installiert${NC}"
else
    echo -e "${YELLOW}ℹ️  Nginx bereits installiert${NC}"
fi

# 4. PM2 installieren
echo ""
echo -e "${GREEN}⚙️  PM2 installieren...${NC}"
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
    echo -e "${GREEN}✅ PM2 installiert${NC}"
else
    echo -e "${YELLOW}ℹ️  PM2 bereits installiert${NC}"
fi

# 5. Nginx Konfiguration kopieren
echo ""
echo -e "${GREEN}📝 Nginx Konfiguration einrichten...${NC}"

# Proxy params
sudo cp "${PROJECT_DIR}/config/nginx/proxy_params.conf" /etc/nginx/

# Site config
sudo cp "${PROJECT_DIR}/config/nginx/chat.canvasstudios.store.conf" /etc/nginx/sites-available/canvas-notebook

# Symlink erstellen
sudo ln -sf /etc/nginx/sites-available/canvas-notebook /etc/nginx/sites-enabled/canvas-notebook

# Default site deaktivieren
if [ -f /etc/nginx/sites-enabled/default ]; then
    sudo rm /etc/nginx/sites-enabled/default
    echo -e "${YELLOW}ℹ️  Default Site deaktiviert${NC}"
fi

# nginx.conf ergänzen
echo ""
echo -e "${YELLOW}📋 Bitte füge folgende Zeilen MANUELL zu /etc/nginx/nginx.conf hinzu:${NC}"
echo -e "${YELLOW}(im http {} Block)${NC}"
cat "${PROJECT_DIR}/config/nginx/nginx.conf.additions"
echo ""
read -p "Drücke Enter wenn erledigt..."

# Config testen
echo ""
echo -e "${GREEN}🔧 Nginx Konfiguration testen...${NC}"
sudo nginx -t

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Nginx Config fehlerhaft!${NC}"
    exit 1
fi

# 6. Firewall konfigurieren
echo ""
echo -e "${GREEN}🔥 Firewall (UFW) konfigurieren...${NC}"
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp comment 'Admin Access'
    sudo ufw allow 80/tcp comment 'HTTP'
    sudo ufw allow 443/tcp comment 'HTTPS'

    # UFW aktivieren (nur wenn noch nicht aktiv)
    if ! sudo ufw status | grep -q "Status: active"; then
        echo "y" | sudo ufw enable
    fi

    sudo ufw status
    echo -e "${GREEN}✅ Firewall konfiguriert${NC}"
else
    echo -e "${YELLOW}⚠️  UFW nicht installiert (apt install ufw)${NC}"
fi

# 7. .env.local prüfen
echo ""
echo -e "${GREEN}🔐 Environment-Variablen prüfen...${NC}"
if [ ! -f "${PROJECT_DIR}/.env.local" ]; then
    echo -e "${RED}❌ .env.local nicht gefunden!${NC}"
    echo "Bitte erstelle .env.local mit:"
    echo "  - BETTER_AUTH_SECRET"
    echo "  - BETTER_AUTH_BASE_URL (oder BASE_URL)"
    echo "  - DATA"
    exit 1
fi

if ! grep -Eq '^[[:space:]]*BETTER_AUTH_SECRET=' "${PROJECT_DIR}/.env.local" || \
   grep -Eq '^[[:space:]]*BETTER_AUTH_SECRET=[[:space:]]*$' "${PROJECT_DIR}/.env.local"; then
    echo -e "${RED}❌ BETTER_AUTH_SECRET fehlt oder ist leer!${NC}"
    echo "Generiere mit: openssl rand -base64 32"
    exit 1
fi

if ! grep -Eq '^[[:space:]]*DATA=' "${PROJECT_DIR}/.env.local" || \
   grep -Eq '^[[:space:]]*DATA=[[:space:]]*$' "${PROJECT_DIR}/.env.local"; then
    echo -e "${RED}❌ DATA fehlt oder ist leer!${NC}"
    exit 1
fi

if ! grep -Eq '^[[:space:]]*(BETTER_AUTH_BASE_URL|BASE_URL)=' "${PROJECT_DIR}/.env.local"; then
    echo -e "${RED}❌ Auth/Base URL fehlt (BETTER_AUTH_BASE_URL oder BASE_URL)!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ .env.local OK${NC}"

# 8. App bauen
echo ""
echo -e "${GREEN}🏗️  Production Build erstellen...${NC}"
cd "${PROJECT_DIR}"
npm install --production=false
npm run build

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build fehlgeschlagen!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build erfolgreich${NC}"

# 9. PM2 einrichten
echo ""
echo -e "${GREEN}🚀 Canvas Notebook mit PM2 starten...${NC}"

# Alte Instanz stoppen (falls vorhanden)
pm2 stop canvas-notebook 2>/dev/null || true
pm2 delete canvas-notebook 2>/dev/null || true

# Neue Instanz starten
cd "${PROJECT_DIR}"
PORT=${APP_PORT} pm2 start npm --name "canvas-notebook" -- start

# PM2 speichern
pm2 save

# PM2 Autostart
pm2 startup | grep "sudo" | bash || true

echo -e "${GREEN}✅ Canvas Notebook läuft auf Port ${APP_PORT}${NC}"

# 10. Nginx starten
echo ""
echo -e "${GREEN}🌐 Nginx neustarten...${NC}"
sudo systemctl restart nginx
sudo systemctl enable nginx

# 11. Status prüfen
echo ""
echo -e "${GREEN}📊 Status prüfen...${NC}"
pm2 status
sudo systemctl status nginx --no-pager -l

# 12. Zusammenfassung
echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           Deployment abgeschlossen! ✅          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}🎉 Canvas Notebook ist jetzt online!${NC}"
echo ""
echo -e "${YELLOW}📋 Nächste Schritte:${NC}"
echo ""
echo "1. Cloudflare DNS konfigurieren:"
echo "   Typ: A"
echo "   Name: chat"
echo "   Content: $(curl -s ifconfig.me)"
echo "   Proxy: ✅ Proxied (Orange Cloud)"
echo ""
echo "2. Cloudflare SSL/TLS einstellen:"
echo "   Encryption Mode: Full"
echo "   Always Use HTTPS: ✅"
echo ""
echo "3. App testen:"
echo "   https://${DOMAIN}"
echo ""
echo "4. Logs ansehen:"
echo "   pm2 logs canvas-notebook"
echo "   sudo tail -f /var/log/nginx/canvas-notebook-access.log"
echo ""
echo "5. App neustarten:"
echo "   pm2 restart canvas-notebook"
echo ""
echo -e "${YELLOW}🔒 Security Reminder:${NC}"
echo "  - BETTER_AUTH_SECRET sicher und lang halten"
echo "  - Fail2ban installieren: sudo apt install fail2ban"
echo ""
echo -e "${GREEN}✅ Fertig!${NC}"
