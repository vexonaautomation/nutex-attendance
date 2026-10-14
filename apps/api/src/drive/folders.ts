import type { AppContext } from '../common/core';

export type FolderKind = 'DOCS' | 'PAYSLIP';
const KEY: Record<FolderKind, string> = { DOCS: 'DRIVE_DOCS_FOLDER_ID', PAYSLIP: 'DRIVE_PAYSLIP_FOLDER_ID' };

/**
 * Drive folder ids live in SYSTEM_CONFIG (written by `npm run google:seed`). Employee documents and payslips each have their own
 * restricted folder. Outside Google (emulator / tests) the id is irrelevant, so a placeholder is used; in production a missing
 * id is a configuration error and must stop the write instead of scattering files into the wrong place.
 */
export async function driveFolder(ctx: AppContext, kind: FolderKind): Promise<string> {
  const id = (await ctx.systemConfig()).str(KEY[kind], '');
  if (id) return id;
  if (ctx.drive.kind === 'google') throw new Error(`${KEY[kind]} is not set in SYSTEM_CONFIG. Run npm run google:seed or set it in Settings.`);
  return 'local';
}
