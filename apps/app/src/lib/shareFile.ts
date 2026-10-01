import type { ExportFile } from './dataExport';

/** Web: download the file. Native counterpart: shareFile.native.ts. */
export async function shareFile({ filename, text }: ExportFile): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
