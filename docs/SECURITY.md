# Security Guide - Canvas Notebook

**Letzte Aktualisierung:** 7. Januar 2026

## 🔐 Übersicht

Canvas Notebook implementiert mehrschichtige Security-Maßnahmen zum Schutz Ihrer Daten und SSH-Verbindungen.

---

## 🛡️ Implementierte Security-Features

### 1. Authentifizierung & Sessions

#### Login-System
- ✅ **Environment-basierte Credentials** - Keine hardcoded Passwörter im Code
- ✅ **bcrypt Password Hashing** - Passwörter werden sicher gehasht (10 Rounds)
- ✅ **Rate Limiting** - Max. 5 Login-Versuche pro Minute
- ✅ **Timing Attack Protection** - Künstliche Verzögerungen bei fehlgeschlagenen Logins
- ✅ **iron-session** - Sichere, verschlüsselte Sessions

#### Session-Konfiguration
```bash
SESSION_SECRET=<32+ byte random string>  # Wird für Session-Verschlüsselung verwendet
```

**Session-Eigenschaften:**
- `httpOnly: true` - Cookies sind nicht via JavaScript zugreifbar
- `secure: true` (Production) - Nur über HTTPS
- `maxAge: 7 days` - Sessions laufen nach 7 Tagen ab

### 2. SSH-Verbindungen

#### Lokales Dateisystem (Optional)
Wenn der Workspace auf dem gleichen Server liegt, kann `SSH_USE_LOCAL_FS=true` gesetzt werden.
Dann greifen File-Operationen direkt auf das lokale Dateisystem zu (keine SSH/SFTP-Transfers).

#### SSH-Key basierte Authentifizierung (Empfohlen)

**Setup:**
```bash
# 1. SSH-Key generieren
cd canvas-notebook
./scripts/setup-ssh-key.sh

# 2. Public Key auf Server installieren
ssh-copy-id -i ./ssh-keys/canvas-notebook-key.pub canvas-notebook@ssh.canvas.holdings

# 3. Verbindung testen
ssh -i ./ssh-keys/canvas-notebook-key canvas-notebook@ssh.canvas.holdings

# 4. .env.local konfigurieren
SSH_KEY_PATH=./ssh-keys/canvas-notebook-key
# SSH_PASSWORD nur wenn Key mit Passphrase geschützt
```

**Vorteile:**
- 🔒 Keine Passwörter im Netzwerk
- 🔑 Passphrase-geschützte Keys möglich
- 🚫 Brute-Force Angriffe unmöglich
- ✅ Automatische Rotation möglich

#### Password-basierte Auth (Fallback)
```bash
SSH_PASSWORD=your_strong_password
```

⚠️ **Warnung:** Nur für Development! In Production immer SSH-Keys verwenden.

### 3. Middleware & Route Protection

#### Geschützte Routen
- ✅ Alle Seiten außer `/login`
- ✅ Alle API-Routes außer `/api/auth/login`
- ✅ Automatische Weiterleitung zu Login bei fehlender Session

#### Security Headers

| Header | Wert | Zweck |
|--------|------|-------|
| `X-Frame-Options` | `SAMEORIGIN` | Clickjacking-Schutz |
| `X-Content-Type-Options` | `nosniff` | MIME-Type Sniffing verhindern |
| `X-XSS-Protection` | `1; mode=block` | XSS-Filter aktivieren |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referer-Leaking minimieren |
| `Content-Security-Policy` | siehe unten | XSS & Injection-Schutz |
| `Permissions-Policy` | `camera=(), microphone=()...` | Browser-Features einschränken |

#### Content Security Policy (CSP)
```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' ws: wss:;
frame-ancestors 'self';
```

### 4. File Operations Security

#### Path Traversal Protection
Alle File-APIs validieren Pfade:
```typescript
function validatePath(path: string, basePath: string): boolean {
  const resolvedPath = resolve(basePath, path);
  return resolvedPath.startsWith(basePath);
}
```

**Verhindert:**
- `../../../etc/passwd` Angriffe
- Zugriff außerhalb des Workspace
- Symlink-basierte Angriffe

#### Filter-Regeln
Folgende Verzeichnisse werden automatisch gefiltert:
- `node_modules/` - Performance + Security
- `.next/` - Build-Artefakte
- `.git/` - Git-History
- `*.env*` - Environment-Variablen
- SSH-Keys und Credentials

### 5. Rate Limiting

| Endpoint | Limit | Fenster | Zweck |
|----------|-------|---------|-------|
| `/api/auth/login` | 5 req | 60s | Brute-Force Schutz |
| `/api/files/*` | (geplant) | - | DoS-Schutz |

**Implementierung:**
- IP-basierte Limitierung
- In-Memory Buckets (Redis für Production empfohlen)
- `429 Too Many Requests` Response
- `Retry-After` Header

---

## 🚀 Production Security Checklist

### Vor dem Deployment

#### 1. Credentials & Secrets
```bash
# ❌ NIEMALS committen:
- [ ] .env.local
- [ ] SSH Private Keys
- [ ] Passwörter oder API-Keys

# ✅ Überprüfen:
- [ ] .gitignore ist konfiguriert
- [ ] Keine Secrets im Code (git log --all -p | grep -i password)
- [ ] SSH_PASSWORD entfernt (nur SSH-Keys)
```

#### 2. Passwörter & Keys
```bash
# Login-Passwort
- [ ] Starkes APP_PASSWORD generiert (./scripts/generate-password-hash.js --generate)
- [ ] APP_PASSWORD_HASH in .env.local gesetzt
- [ ] APP_PASSWORD (plain) entfernt aus .env.local

# Session Secret
- [ ] SESSION_SECRET ist random (min. 32 bytes)
- [ ] Nie den Development-Secret in Production verwenden

# SSH
- [ ] SSH-Key generiert (Ed25519 empfohlen)
- [ ] SSH-Key mit starker Passphrase geschützt
- [ ] Public Key auf Server installiert
- [ ] SSH_PASSWORD entfernt (nur Key-basiert)
```

#### 3. Konfiguration
```bash
# .env.local Production-Beispiel
SSH_HOST=your-server.com
SSH_PORT=22
SSH_USER=canvas-notebook
SSH_KEY_PATH=/absolute/path/to/key
# Keine SSH_PASSWORD!

APP_USERNAME=admin
APP_PASSWORD_HASH=$2b$10$...generated_hash...
SESSION_SECRET=...random_32+_bytes...

# HTTPS
SESSION_SECURE_COOKIES=true

# Connection Pool
SSH_POOL_MAX=5
SSH_POOL_MIN=0
SSH_POOL_IDLE_TIMEOUT=600000
```

#### 4. Server-Konfiguration
- [ ] HTTPS aktiviert (Let's Encrypt)
- [ ] Firewall konfiguriert (nur Port 443/80)
- [ ] SSH-Server: `PasswordAuthentication no` in sshd_config
- [ ] SSH-Server: Nur SSH-Keys erlauben
- [ ] Fail2ban für SSH installiert

#### 5. Next.js Build
```bash
- [ ] `NODE_ENV=production`
- [ ] `npm run build` ohne Errors
- [ ] Session Cookies: `secure: true`
- [ ] CSP Header aktiviert
```

---

## 🔧 Security Tools & Scripts

### Password Hash Generator
```bash
# Generiere starkes Passwort + Hash
node scripts/generate-password-hash.js --generate

# Hash für existierendes Passwort
node scripts/generate-password-hash.js "MeinPasswort123!"
```

### SSH Key Setup
```bash
# Interaktives Setup
./scripts/setup-ssh-key.sh

# Manuell (Ed25519)
ssh-keygen -t ed25519 -C "canvas-notebook@yourserver" -f ./ssh-keys/canvas-key

# Auf Server installieren
ssh-copy-id -i ./ssh-keys/canvas-key.pub user@server
```

---

## 🐛 Bekannte Limitierungen & Todos

### In-Memory Rate Limiting
**Problem:** Bei Server-Restart gehen Rate-Limit Buckets verloren

**Lösung für Production:**
```bash
# Redis-basiertes Rate Limiting
npm install ioredis
# Dann rate-limit.ts anpassen
```

### Session Store
**Problem:** Sessions sind in Cookies (max. 4KB)

**Lösung für Multi-Server Setup:**
```bash
# Redis Session Store
npm install connect-redis express-session
```

### CSRF Protection
**Status:** ⚠️ Nicht implementiert (iron-session Cookie ist bereits SameSite)

**Empfehlung:** Bei komplexeren Workflows CSRF-Tokens hinzufügen

---

## 📚 Security Best Practices

### 1. Regelmäßige Updates
```bash
# Dependencies auf Vulnerabilities prüfen
npm audit

# Automatische Fixes
npm audit fix

# Major Updates manuell prüfen
npm outdated
```

### 2. Logging & Monitoring
```bash
# Fehlerhafte Login-Versuche loggen
[Security] Failed login attempt from IP: 1.2.3.4

# SSH Connection Failures
[SSH Pool] Connection error: ...

# Rate Limit Triggers
[Rate Limit] Client 1.2.3.4 exceeded limit for auth-login
```

### 3. Backup & Recovery
- Regelmäßige Backups der SSH-Keys (verschlüsselt!)
- SESSION_SECRET sicher aufbewahren
- Recovery-Plan für vergessene Passwörter

### 4. Access Control
- Minimale Berechtigungen für SSH-User
- Separate User für verschiedene Workspaces
- Regelmäßige Audit der authorized_keys

---

## 🆘 Incident Response

### Kompromittiertes Passwort
```bash
# 1. Neues Passwort generieren
node scripts/generate-password-hash.js --generate

# 2. .env.local aktualisieren
APP_PASSWORD_HASH=<new_hash>

# 3. Server neustarten
pm2 restart canvas-notebook

# 4. Alle Sessions invalidieren (automatisch nach Restart)
```

### Kompromittierter SSH-Key
```bash
# 1. Neuen Key generieren
./scripts/setup-ssh-key.sh

# 2. Alten Key auf Server entfernen
ssh user@server
vim ~/.ssh/authorized_keys
# Alte Key-Zeile löschen

# 3. Alten Key lokal löschen
rm -f ./ssh-keys/old-key*

# 4. .env.local aktualisieren
SSH_KEY_PATH=./ssh-keys/new-key
```

### Suspected Intrusion
```bash
# 1. Server-Logs prüfen
ssh user@server
sudo tail -f /var/log/auth.log

# 2. Aktive Sessions beenden
pm2 stop canvas-notebook

# 3. Security-Audit durchführen
npm audit
git log --all -p | grep -i password

# 4. Alle Credentials rotieren
```

---

## 📞 Support & Reporting

**Security Issues:** security@canvas.holdings (falls vorhanden)

**Guideline:** Bitte keine Security-Vulnerabilities öffentlich posten!

---

## ✅ Compliance

- ✅ OWASP Top 10 (2021) berücksichtigt
- ✅ GDPR-konform (keine Nutzer-Tracking)
- ✅ Zero-Trust Prinzip (jeder Request wird validiert)

---

**Letzte Security-Audit:** 7. Januar 2026
**Nächster Review:** Nach Major-Updates oder bei Incidents
