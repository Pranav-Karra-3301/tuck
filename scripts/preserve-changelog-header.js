#!/usr/bin/env node

/**
 * Script to preserve the changelog image header after semantic-release updates CHANGELOG.md
 * This script ensures the image is always at the top of the changelog file.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const changelogPath = join(rootDir, 'CHANGELOG.md');

const CHANGELOG_HEADER = `<img src="public/Changelog.png" alt="Changelog" style="width:100%;">\n\n`;

try {
  const content = readFileSync(changelogPath, 'utf-8');
  
  // Check if header is already present
  if (content.startsWith(CHANGELOG_HEADER)) {
    console.log('✓ Changelog header already present');
    process.exit(0);
  }
  
  // Check if image tag exists elsewhere in the file (shouldn't happen, but just in case)
  if (content.includes('Changelog.png')) {
    console.log('⚠ Changelog image found but not at the top. Prepending header...');
    // Remove any existing image references and prepend
    const cleanedContent = content.replace(/<img[^>]*Changelog\.png[^>]*>\n*/g, '');
    const newContent = CHANGELOG_HEADER + cleanedContent;
    writeFileSync(changelogPath, newContent, 'utf-8');
    console.log('✓ Changelog header prepended');
  } else {
    // No header found, prepend it
    const newContent = CHANGELOG_HEADER + content;
    writeFileSync(changelogPath, newContent, 'utf-8');
    console.log('✓ Changelog header added');
  }
  
  process.exit(0);
} catch (error) {
  console.error('Error preserving changelog header:', error);
  process.exit(1);
}

