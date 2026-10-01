import { Share } from 'react-native';

import type { ExportFile } from './dataExport';

/** Native: hand the text to the OS share sheet (save to Files, mail, and so on). */
export async function shareFile({ filename, text }: ExportFile): Promise<void> {
  await Share.share({ title: filename, message: text });
}
