/* eslint-disable @typescript-eslint/no-require-imports */
const bcrypt = require('bcryptjs');

const ADMIN_USERNAME = process.env.APP_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.APP_PASSWORD_HASH;
const ADMIN_PASSWORD_PLAIN = process.env.APP_PASSWORD;

console.log('ENV ADMIN_USERNAME:', ADMIN_USERNAME);
console.log('ENV ADMIN_PASSWORD_HASH:', ADMIN_PASSWORD_HASH);
console.log('ENV ADMIN_PASSWORD_PLAIN:', ADMIN_PASSWORD_PLAIN);

const username = 'admin';
const password = '7b&BIfeGW)a[3!AKCOKJ';

console.log('\nTesting with:', username, password);

if (username !== ADMIN_USERNAME) {
  console.log('Username mismatch!');
} else {
  console.log('Username OK');

  if (ADMIN_PASSWORD_HASH) {
    console.log('Using hash comparison...');
    bcrypt.compare(password, ADMIN_PASSWORD_HASH).then(result => {
      console.log('Hash comparison result:', result);
    });
  } else if (ADMIN_PASSWORD_PLAIN) {
    console.log('Using plain comparison...');
    console.log('Plain comparison:', password === ADMIN_PASSWORD_PLAIN);
  } else {
    console.log('No password configured!');
  }
}
