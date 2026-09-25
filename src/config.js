import os from 'node:os';
import path from 'node:path';

const appData = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'LocalNotes')
  : path.join(os.homedir(), '.local', 'share', 'local-notes');

export const dataDirectory = path.resolve(process.env.NOTES_DATA_DIR || appData);
export const databasePath = path.resolve(process.env.NOTES_DATABASE_PATH || path.join(dataDirectory, 'notes.sqlite'));
export const exportDirectory = path.resolve(
  process.env.NOTES_EXPORT_DIR || path.join(os.homedir(), 'Documents', 'Local Notes Export'),
);
export const port = Number.parseInt(process.env.PORT || '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
