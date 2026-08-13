import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'src-tauri', 'icons', 'android');
const resourceRoot = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const iconNames = [
  'ic_launcher.png',
  'ic_launcher_round.png',
  'ic_launcher_background.png',
  'ic_launcher_foreground.png',
  'ic_launcher_monochrome.png',
];

await Promise.all(densities.flatMap((density) => iconNames.map(async (iconName) => {
  const targetDir = path.join(resourceRoot, `mipmap-${density}`);
  await mkdir(targetDir, { recursive: true });
  await cp(
    path.join(sourceRoot, `mipmap-${density}`, iconName),
    path.join(targetDir, iconName),
  );
})));

await mkdir(path.join(resourceRoot, 'mipmap-anydpi-v26'), { recursive: true });
await cp(
  path.join(sourceRoot, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
  path.join(resourceRoot, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
);
