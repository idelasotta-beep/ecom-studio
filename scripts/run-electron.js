// Wrapper que lanza Electron limpiando ELECTRON_RUN_AS_NODE si está
// seteada en el entorno del usuario. Esa variable hace que Electron
// se comporte como Node CLI puro (require('electron') devuelve el path
// del binario en vez del módulo), y rompe el main process.
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const projectRoot = path.join(__dirname, '..');
const proc = spawn(electronPath, [projectRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
proc.on('close', (code) => process.exit(code));
