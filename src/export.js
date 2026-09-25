import fs from 'node:fs/promises';
import path from 'node:path';
import { exportDirectory } from './config.js';
import { db } from './database.js';

const manifestName = '.local-notes-export.json';

function safeBaseName(title) {
  const slug = title.normalize('NFKD').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'page';
  return slug;
}

async function writeAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, contents, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export async function exportPages() {
  await fs.mkdir(exportDirectory, { recursive: true });
  const pages = db.prepare('SELECT id, title, content, updated_at FROM pages ORDER BY id').all();
  const filenames = new Set();
  const entries = pages.map((page) => {
    const filename = `${safeBaseName(page.title)}-${page.id}.md`;
    filenames.add(filename);
    const markdown = `# ${page.title}\n\n${page.content}${page.content.endsWith('\n') || page.content === '' ? '' : '\n'}`;
    return { filename, markdown };
  });

  const manifestPath = path.join(exportDirectory, manifestName);
  let previousFiles = [];
  try {
    const previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (Array.isArray(previous.files)) previousFiles = previous.files.filter((name) => typeof name === 'string' && path.basename(name) === name && name.endsWith('.md'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  for (const { filename, markdown } of entries) {
    await writeAtomically(path.join(exportDirectory, filename), markdown);
  }
  for (const filename of previousFiles) {
    if (!filenames.has(filename)) await fs.rm(path.join(exportDirectory, filename), { force: true });
  }
  await writeAtomically(manifestPath, `${JSON.stringify({ exported_at: new Date().toISOString(), files: [...filenames] }, null, 2)}\n`);

  return { exported_at: new Date().toISOString(), count: entries.length, directory: exportDirectory };
}
