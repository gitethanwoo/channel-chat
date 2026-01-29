#!/usr/bin/env node
/**
 * Build script to embed the UI HTML into a TypeScript module.
 * Run with: npm run build:ui
 */

const fs = require('fs');
const path = require('path');

const uiDistPath = path.resolve(__dirname, '../../ui/dist/index.html');
const outputPath = path.resolve(__dirname, '../src/ui-html.ts');

if (!fs.existsSync(uiDistPath)) {
  console.error(`Error: UI bundle not found at ${uiDistPath}`);
  console.error('Run "npm run build" in the ui directory first.');
  process.exit(1);
}

const html = fs.readFileSync(uiDistPath, 'utf8');

// Escape backticks and dollar signs for template literal
const escapedHtml = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$/g, '\\$');

const output = `// Auto-generated - do not edit manually
// Run: npm run build:ui to regenerate
export const UI_HTML = \`${escapedHtml}\`;
`;

fs.writeFileSync(outputPath, output);

console.log(`Generated ${outputPath} (${(html.length / 1024).toFixed(1)} KB)`);
