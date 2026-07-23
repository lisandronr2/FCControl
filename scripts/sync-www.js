// Copia los assets web (fuente de verdad = raíz del repo) a www/ para que
// Capacitor los empaquete en la app nativa. www/ es un artefacto de build,
// no se edita a mano ni se versiona.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW  = path.join(ROOT, 'www');

const FILES = [
  'index.html',
  'manifest.json',
  'icon.svg',
  'html5-qrcode.min.js'
];

if (!fs.existsSync(WWW)) fs.mkdirSync(WWW, { recursive: true });

for (const file of FILES) {
  const src = path.join(ROOT, file);
  const dest = path.join(WWW, file);
  if (!fs.existsSync(src)) {
    console.warn('⚠ No encontrado, se omite:', file);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log('✓', file);
}

console.log('\nwww/ sincronizado.');
