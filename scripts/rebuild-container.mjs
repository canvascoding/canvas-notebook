#!/usr/bin/env node

/**
 * Rebuild Container Script
 * 
 * Dieses Skript:
 * 1. Stoppt und löscht den alten Container auf Port 3000
 * 2. Baut einen neuen Container ohne Cache
 * 3. Startet den Container mit den richtigen Volumes
 * 
 * Verwendung: npm run container:rebuild
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');

const CONTAINER_NAME = 'canvas-notebook';
const PORT = 3456;
const IMAGE_NAME = 'canvas-notebook:latest';
const ENV_FILE = join(rootDir, '.env.docker.local');

// Farben für die Ausgabe
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  log(`> ${command}`, 'cyan');
  try {
    return execSync(command, { 
      stdio: 'inherit', 
      cwd: rootDir,
      ...options 
    });
  } catch (error) {
    if (!options.ignoreError) {
      throw error;
    }
  }
}

function ensureDataDirs() {
  const dataDir = join(rootDir, 'data');
  const subdirs = ['workspace', 'canvas-agent', 'pi-oauth-states', 'secrets', 'skills'];
  
  if (!existsSync(dataDir)) {
    log('Erstelle data/ Verzeichnis...', 'yellow');
    mkdirSync(dataDir, { recursive: true });
  }
  
  for (const subdir of subdirs) {
    const path = join(dataDir, subdir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }
}

async function main() {
  log('========================================', 'blue');
  log('  Canvas Notebook - Container Rebuild', 'blue');
  log('========================================', 'blue');
  console.log();

  // Schritt 1: Prüfe ob Docker verfügbar ist
  log('Schritt 1: Prüfe Docker...', 'yellow');
  try {
    execSync('docker --version', { stdio: 'pipe' });
    log('✓ Docker ist verfügbar', 'green');
  } catch (error) {
    log('✗ Docker ist nicht verfügbar. Bitte installiere Docker.', 'red');
    process.exit(1);
  }
  console.log();

  // Schritt 2: Stoppe und lösche alten Container
  log('Schritt 2: Stoppe und lösche alten Container...', 'yellow');
  try {
    // Finde Container auf Port 3000
    const containerId = execSync(
      `docker ps -q --filter "publish=${PORT}"`,
      { encoding: 'utf-8', cwd: rootDir }
    ).toString().trim();
    
    if (containerId) {
      log(`Gefundener Container auf Port ${PORT}: ${containerId}`, 'cyan');
      exec(`docker stop ${containerId}`, { ignoreError: true });
      exec(`docker rm ${containerId}`, { ignoreError: true });
      log('✓ Alter Container gestoppt und gelöscht', 'green');
    } else {
      log(`Kein Container auf Port ${PORT} gefunden`, 'cyan');
    }
    
    // Lösche auch den benannten Container falls vorhanden
    exec(`docker stop ${CONTAINER_NAME}`, { ignoreError: true });
    exec(`docker rm ${CONTAINER_NAME}`, { ignoreError: true });
  } catch (error) {
    log('Kein alter Container zum Löschen gefunden', 'cyan');
  }
  console.log();

  // Schritt 3: Stelle sicher, dass die Datenverzeichnisse existieren
  log('Schritt 3: Prüfe Datenverzeichnisse...', 'yellow');
  ensureDataDirs();
  log('✓ Datenverzeichnisse sind bereit', 'green');
  console.log();

  // Schritt 4: Baue neuen Container ohne Cache
  log('Schritt 4: Baue neuen Container (no-cache)...', 'yellow');
  log('Dies kann einige Minuten dauern...', 'cyan');
  console.log();
  
  try {
    exec(`docker build --no-cache -t ${IMAGE_NAME} .`);
    log('✓ Container erfolgreich gebaut', 'green');
  } catch (error) {
    log('✗ Fehler beim Bauen des Containers', 'red');
    process.exit(1);
  }
  console.log();

  // Schritt 5: Starte neuen Container
  log('Schritt 5: Starte neuen Container...', 'yellow');
  
  const dataDir = join(rootDir, 'data');
  
  // Prüfe ob .env.docker.local existiert
  let envFileOption = '';
  if (existsSync(ENV_FILE)) {
    log(`Lade Umgebungsvariablen aus: ${ENV_FILE}`, 'cyan');
    envFileOption = `--env-file "${ENV_FILE}"`;
  } else {
    log(`Warnung: ${ENV_FILE} nicht gefunden`, 'yellow');
  }
  
  const runCommand = `docker run -d \\
    --name ${CONTAINER_NAME} \\
    -p ${PORT}:3000 \\
    -v "${dataDir}:/data" \\
    ${envFileOption} \\
    -e NODE_ENV=production \\
    -e CANVAS_RUNTIME_ENV=docker \\
    -e PORT=3000 \\
    -e HOSTNAME=0.0.0.0 \\
    -e WORKSPACE_DIR=/data/workspace \\
    -e SQLITE_PATH=/data/sqlite.db \\
    -e ALLOW_SIGNUP=false \\
    --restart unless-stopped \\
    ${IMAGE_NAME}`;
  
  log('Starte Container mit folgenden Einstellungen:', 'cyan');
  log(`  Name: ${CONTAINER_NAME}`, 'cyan');
  log(`  Port: ${PORT}:3000`, 'cyan');
  log(`  Volume: ${dataDir}:/data`, 'cyan');
  console.log();
  
  try {
    exec(runCommand.replace(/\\\n\s*/g, ' '));
    log('✓ Container gestartet', 'green');
  } catch (error) {
    log('✗ Fehler beim Starten des Containers', 'red');
    process.exit(1);
  }
  console.log();

  // Schritt 6: Warte und zeige Status
  log('Schritt 6: Warte auf Container-Start...', 'yellow');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    const status = execSync(
      `docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`,
      { encoding: 'utf-8', cwd: rootDir }
    ).toString();
    
    log('Container Status:', 'blue');
    console.log(status);
    
    const logs = execSync(
      `docker logs --tail 20 ${CONTAINER_NAME}`,
      { encoding: 'utf-8', cwd: rootDir }
    ).toString();
    
    log('Letzte Logs:', 'blue');
    console.log(logs);
  } catch (error) {
    log('Konnte Container-Status nicht abrufen', 'yellow');
  }
  console.log();

  log('========================================', 'green');
  log('  Container erfolgreich neu aufgesetzt!', 'green');
  log('========================================', 'green');
  log(`  URL: http://localhost:${PORT}`, 'cyan');
  log(`  Name: ${CONTAINER_NAME}`, 'cyan');
  log(`  Daten: ${dataDir}`, 'cyan');
  log('========================================', 'green');
  console.log();
  log('Nützliche Befehle:', 'blue');
  log(`  docker logs -f ${CONTAINER_NAME}    # Logs anzeigen`, 'cyan');
  log(`  docker exec -it ${CONTAINER_NAME} sh  # In Container shell`, 'cyan');
  log(`  docker stop ${CONTAINER_NAME}         # Container stoppen`, 'cyan');
}

main().catch(error => {
  log(`\nFehler: ${error.message}`, 'red');
  process.exit(1);
});
