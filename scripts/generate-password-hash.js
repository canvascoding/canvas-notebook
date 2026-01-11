#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Passwort-Hash Generator für Canvas Notebook
 * Generiert bcrypt Hashes für APP_PASSWORD_HASH
 */

const { hashSync } = require('bcryptjs');
const { randomBytes } = require('crypto');

console.log('🔐 Canvas Notebook - Passwort-Hash Generator');
console.log('=============================================\n');

// Generiere starkes Random-Passwort
const generateStrongPassword = (length = 20) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}';
  let password = '';
  const randomBytesArray = randomBytes(length);
  for (let i = 0; i < length; i++) {
    password += chars[randomBytesArray[i] % chars.length];
  }
  return password;
};

// Generiere SESSION_SECRET
const generateSessionSecret = () => {
  return randomBytes(32).toString('base64');
};

// Haupt-Funktion
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  node generate-password-hash.js [password]');
    console.log('  node generate-password-hash.js --generate');
    console.log('\nOptions:');
    console.log('  --generate    Generiere ein starkes Random-Passwort');
    console.log('  --help, -h    Zeige diese Hilfe');
    return;
  }

  let password;

  if (args.includes('--generate')) {
    password = generateStrongPassword();
    console.log('✅ Starkes Passwort generiert!\n');
  } else if (args.length > 0) {
    password = args.join(' ');
  } else {
    console.error('❌ Fehler: Passwort erforderlich\n');
    console.log('Verwendung:');
    console.log('  node generate-password-hash.js "MeinPasswort123!"');
    console.log('  node generate-password-hash.js --generate\n');
    process.exit(1);
  }

  // Generiere bcrypt Hash (10 rounds)
  const hash = hashSync(password, 10);
  const sessionSecret = generateSessionSecret();

  console.log('📋 Konfiguration für .env.local:');
  console.log('=================================\n');
  console.log('# App Login Credentials');
  console.log('APP_USERNAME=admin');
  console.log(`APP_PASSWORD_HASH=${hash}`);
  console.log(`# APP_PASSWORD=${password}  # Optional: Nur für Entwicklung, entfernen in Production!\n`);
  console.log('# Session Secret (32 bytes base64)');
  console.log(`SESSION_SECRET=${sessionSecret}\n`);

  if (args.includes('--generate')) {
    console.log('⚠️  WICHTIG: Notieren Sie sich das Passwort sicher:');
    console.log(`   Passwort: ${password}\n`);
  }

  console.log('✅ Fügen Sie die obigen Zeilen zu Ihrer .env.local hinzu!');
}

main();
