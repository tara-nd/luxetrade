// electron-builder's NSIS target writes the installer as "ProductName Setup
// X.Y.Z.exe" (spaces) but latest.yml (read by electron-updater at runtime)
// references it as "ProductName-Setup-X.Y.Z.exe" (hyphens). If those two
// don't match, auto-update downloads 404. Run after every `electron-builder`
// build so the release assets always match what latest.yml expects.
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const distDir = path.join(__dirname, '..', 'dist');
const latestYmlPath = path.join(distDir, 'latest.yml');

if (!fs.existsSync(latestYmlPath)) {
    console.log('No latest.yml found, skipping artifact rename.');
    process.exit(0);
}

const match = fs.readFileSync(latestYmlPath, 'utf-8').match(/^path:\s*(.+)$/m);
if (!match) {
    console.error('Could not find "path:" in latest.yml');
    process.exit(1);
}
const expectedName = match[1].trim();

const productName = pkg.build?.productName || pkg.name;
const builtName = `${productName} Setup ${pkg.version}.exe`;

if (builtName === expectedName) {
    console.log('Artifact name already matches latest.yml, nothing to rename.');
    process.exit(0);
}

const builtPath = path.join(distDir, builtName);
if (!fs.existsSync(builtPath)) {
    console.error(`Expected built installer not found: ${builtPath}`);
    process.exit(1);
}

fs.renameSync(builtPath, path.join(distDir, expectedName));
console.log(`Renamed "${builtName}" -> "${expectedName}"`);

const builtBlockmap = `${builtPath}.blockmap`;
if (fs.existsSync(builtBlockmap)) {
    fs.renameSync(builtBlockmap, path.join(distDir, `${expectedName}.blockmap`));
    console.log(`Renamed "${builtName}.blockmap" -> "${expectedName}.blockmap"`);
}
