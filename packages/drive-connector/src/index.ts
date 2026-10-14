import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createGoogleAuth, withRetry, type GoogleAuthConfig } from '@nutex/sheet-connector';

/**
 * Drive holds binaries only (employee documents, payslip PDFs). A service account has no storage quota of its own, so on real Google
 * the folders must live in a Shared Drive (or be reached through OAuth / delegation); see SETUP_GOOGLE.md.
 * Sheets keeps IDs, hashes and metadata. Folder ids come from SYSTEM_CONFIG (DRIVE_*_FOLDER_ID).
 */
export interface StoredFile { id: string; name: string; size: number }

export interface DriveStore {
  readonly kind: 'google' | 'local';
  put(folderId: string, name: string, data: Buffer, mimeType: string): Promise<StoredFile>;
  get(fileId: string): Promise<Buffer>;
  remove(fileId: string): Promise<void>;
  /** create a folder (used by setup) */
  createFolder(name: string, parentId?: string): Promise<string>;
}

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export class GoogleDriveStore implements DriveStore {
  readonly kind = 'google' as const;
  private drive: drive_v3.Drive;
  constructor(cfg: GoogleAuthConfig) {
    this.drive = google.drive({ version: 'v3', auth: createGoogleAuth({ ...cfg, scopes: cfg.scopes ?? DRIVE_SCOPES }) });
  }

  async createFolder(name: string, parentId?: string): Promise<string> {
    const res = await withRetry(() => this.drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined }, fields: 'id',
    }));
    return res.data.id!;
  }

  async put(folderId: string, name: string, data: Buffer, mimeType: string): Promise<StoredFile> {
    const res = await withRetry(() => this.drive.files.create({
      requestBody: { name, parents: [folderId] }, media: { mimeType, body: Readable.from(data) }, fields: 'id,name,size',
    }));
    return { id: res.data.id!, name: res.data.name ?? name, size: Number(res.data.size ?? data.length) };
  }

  async get(fileId: string): Promise<Buffer> {
    const res = await withRetry(() => this.drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }));
    return Buffer.from(res.data as ArrayBuffer);
  }

  async remove(fileId: string): Promise<void> {
    await withRetry(() => this.drive.files.delete({ fileId }));
  }
}

/** Local filesystem store for tests / offline development only. */
export class LocalDriveStore implements DriveStore {
  readonly kind = 'local' as const;
  constructor(private root: string) {
    if (process.env.NODE_ENV === 'production') throw new Error('LocalDriveStore must not be used in production');
  }
  private p(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid file id');
    return path.join(this.root, id);
  }
  async createFolder(name: string): Promise<string> {
    return `local-folder-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  }
  async put(_folderId: string, name: string, data: Buffer): Promise<StoredFile> {
    await mkdir(this.root, { recursive: true });
    const id = randomUUID();
    await writeFile(this.p(id), data);
    return { id, name, size: data.length };
  }
  async get(fileId: string): Promise<Buffer> { return readFile(this.p(fileId)); }
  async remove(fileId: string): Promise<void> { await rm(this.p(fileId), { force: true }); }
}

/** in-memory store for unit tests */
export class MemoryDriveStore implements DriveStore {
  readonly kind = 'local' as const;
  files = new Map<string, { name: string; data: Buffer; folderId: string }>();
  async createFolder(name: string) { return `mem-${name}`; }
  async put(folderId: string, name: string, data: Buffer): Promise<StoredFile> {
    const id = randomUUID();
    this.files.set(id, { name, data, folderId });
    return { id, name, size: data.length };
  }
  async get(fileId: string) {
    const f = this.files.get(fileId);
    if (!f) throw new Error('File not found');
    return f.data;
  }
  async remove(fileId: string) { this.files.delete(fileId); }
}
