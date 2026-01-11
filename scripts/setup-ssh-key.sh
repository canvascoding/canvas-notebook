#!/bin/bash
# SSH Key Setup Script für Canvas Notebook
# Generiert einen SSH-Key und konfiguriert die Verbindung

set -e

echo "🔐 Canvas Notebook - SSH Key Setup"
echo "===================================="
echo ""

# Farben für Output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Konfiguration
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_KEYS_DIR="$PROJECT_DIR/ssh-keys"
KEY_NAME="canvas-notebook-key"
SSH_HOST="${SSH_HOST:-ssh.canvas.holdings}"
SSH_USER="${SSH_USER:-canvas-notebook}"

echo "Projekt-Verzeichnis: $PROJECT_DIR"
echo "SSH Keys Verzeichnis: $SSH_KEYS_DIR"
echo ""

# 1. Erstelle ssh-keys Verzeichnis
echo "📁 Erstelle SSH-Keys Verzeichnis..."
mkdir -p "$SSH_KEYS_DIR"
chmod 700 "$SSH_KEYS_DIR"

# 2. Generiere SSH-Key
KEY_PATH="$SSH_KEYS_DIR/$KEY_NAME"

if [ -f "$KEY_PATH" ]; then
    echo -e "${YELLOW}⚠️  SSH-Key existiert bereits: $KEY_PATH${NC}"
    read -p "Möchten Sie einen neuen Key generieren? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Verwende existierenden Key."
    else
        echo "Generiere neuen Key..."
        rm -f "$KEY_PATH" "$KEY_PATH.pub"
    fi
fi

if [ ! -f "$KEY_PATH" ]; then
    echo -e "${GREEN}🔑 Generiere neuen SSH-Key...${NC}"
    echo ""
    echo "WICHTIG: Sie können eine Passphrase setzen für zusätzliche Sicherheit."
    echo "Die Passphrase wird dann in .env.local als SSH_PASSWORD gespeichert."
    echo ""

    # Generiere Ed25519 Key (moderner und sicherer als RSA)
    ssh-keygen -t ed25519 -C "canvas-notebook@${SSH_HOST}" -f "$KEY_PATH"

    chmod 600 "$KEY_PATH"
    chmod 644 "$KEY_PATH.pub"

    echo -e "${GREEN}✅ SSH-Key erfolgreich generiert!${NC}"
else
    echo "SSH-Key existiert bereits."
fi

echo ""

# 3. Zeige Public Key
echo "📋 Public Key (muss auf dem Server installiert werden):"
echo "==========================================================="
cat "$KEY_PATH.pub"
echo "==========================================================="
echo ""

# 4. Installationsanleitung
echo -e "${YELLOW}📝 Nächste Schritte:${NC}"
echo ""
echo "1. Kopieren Sie den obigen Public Key"
echo ""
echo "2. Auf dem SSH-Server ($SSH_HOST) ausführen:"
echo "   ssh $SSH_USER@$SSH_HOST"
echo "   mkdir -p ~/.ssh"
echo "   chmod 700 ~/.ssh"
echo "   echo 'PASTE_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys"
echo "   chmod 600 ~/.ssh/authorized_keys"
echo ""
echo "3. Oder verwenden Sie ssh-copy-id:"
echo "   ssh-copy-id -i $KEY_PATH.pub $SSH_USER@$SSH_HOST"
echo ""
echo "4. Testen Sie die Verbindung:"
echo "   ssh -i $KEY_PATH $SSH_USER@$SSH_HOST"
echo ""
echo "5. Aktualisieren Sie .env.local:"
echo "   SSH_KEY_PATH=$KEY_PATH"
echo ""
if [ ! -f "$KEY_PATH.pass" ]; then
    echo "   # Wenn Sie eine Passphrase gesetzt haben:"
    echo "   SSH_PASSWORD=your_key_passphrase"
    echo ""
    echo "   # Wenn keine Passphrase (unsicherer!):"
    echo "   # SSH_PASSWORD kann entfernt werden"
else
    echo "   SSH_PASSWORD=$(cat "$KEY_PATH.pass")"
fi
echo ""

# 5. Erstelle .env.local Vorlage wenn nicht vorhanden
if [ ! -f "$PROJECT_DIR/.env.local" ]; then
    echo -e "${GREEN}📝 Erstelle .env.local Vorlage...${NC}"
    cat > "$PROJECT_DIR/.env.local" << EOF
# SSH Configuration
SSH_HOST=$SSH_HOST
SSH_PORT=22
SSH_USER=$SSH_USER
SSH_KEY_PATH=$KEY_PATH
# SSH_PASSWORD=your_key_passphrase (nur wenn Key mit Passphrase geschützt)

# App Configuration
APP_USERNAME=admin
APP_PASSWORD=$(openssl rand -base64 16)
SESSION_SECRET=$(openssl rand -base64 32)

# File System
SSH_BASE_PATH=/home/ubuntu/webapp canvasstudios/canvas-notebook

# Terminal
MAX_TERMINALS_PER_USER=3
TERMINAL_IDLE_TIMEOUT=1800000

# Connection Pool
SSH_POOL_MAX=5
SSH_POOL_MIN=0
SSH_POOL_IDLE_TIMEOUT=600000
EOF
    echo -e "${GREEN}✅ .env.local erstellt!${NC}"
else
    echo -e "${YELLOW}⚠️  .env.local existiert bereits. Bitte manuell aktualisieren.${NC}"
fi

echo ""
echo -e "${GREEN}✅ SSH-Key Setup abgeschlossen!${NC}"
echo ""
echo "Der SSH-Key ist in .gitignore und wird NICHT ins Repository committed."
echo ""
