import { BRAND_NAME } from '@forms/shared/brand';

import type { DataExport } from './auth';

export interface ExportFile {
  filename: string;
  text: string;
}

/** The user's copy of their data (export_my_data), as a readable JSON file.
 * Contents are personal data: never log the result. */
export function dataExportFile(data: DataExport, now: Date): ExportFile {
  const day = now.toISOString().slice(0, 10);
  return {
    filename: `${BRAND_NAME.toLowerCase()}-my-data-${day}.json`,
    text: `${JSON.stringify(data, null, 2)}\n`,
  };
}
