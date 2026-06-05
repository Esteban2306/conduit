import { Injectable, BadRequestException } from '@nestjs/common';
import * as xlsx from 'xlsx';
import * as Papa from 'papaparse';

export interface FileParseResult {
  rows: Record<string, unknown>[];
  totalRows: number;
  headers: string[];
  errors: Array<{ row: number; message: string }>;
}

const REQUIRED_COLUMNS = ['address', 'channel'];

@Injectable()
export class FileParserService {
  parse(
    buffer: Buffer,
    mimetype: string,
    originalName: string,
  ): FileParseResult {
    const extension = originalName.split('.').pop()?.toLocaleLowerCase();

    if (
      mimetype === 'text/csv' ||
      mimetype === 'application/csv' ||
      extension === 'csv'
    ) {
      this.parseCsv(buffer);
    }

    if (
      mimetype ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimetype === 'application/vnd.ms-excel' ||
      extension === 'xlsx' ||
      extension === 'xls'
    ) {
      return this.parseExcel(buffer);
    }

    throw new BadRequestException(
      `Formato no soportado: ${mimetype}. Usa CSV o Excel (.xlsx/.xls)`,
    );
  }

  rowsToPayloads(
    rows: Record<string, unknown>[],
    templateId: string,
    extraVariables: Record<string, unknown>,
    scheduledAt: string,
    priority?: 'low' | 'normal' | 'high',
  ): unknown[] {
    return rows.map((row) => {
      const { address, channel, name, ...templateVariables } = row;

      return {
        recipient: {
          channel: String(channel).toUpperCase(),
          address: String(address),
          ...(name ? { name: String(name) } : {}),
        },
        templateId,
        variables: {
          ...templateVariables,
          ...extraVariables,
        },
        options: {
          ...(scheduledAt && { scheduledAt }),
          ...(priority && { priority }),
        },
      };
    });
  }

  private parseCsv(buffer: Buffer): FileParseResult {
    const text = buffer.toString('utf-8');

    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLocaleLowerCase(),
      transform: (value) => value.trim(),
    });

    this.validateHeaders(result.meta.fields ?? []);
    const errors: Array<{ row: number; message: string }> = result.errors.map(
      (e) => ({ row: e.row ?? 0, message: e.message }),
    );

    return {
      rows: result.data,
      totalRows: result.data.length,
      headers: result.meta.fields ?? [],
      errors,
    };
  }

  private parseExcel(buffer: Buffer): FileParseResult {
    const workbook = xlsx.read(buffer, { type: 'buffer' });

    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      throw new BadRequestException('excel file dont has laves');
    }

    const sheet = workbook.Sheets[sheetName];

    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    });

    const normalizedRows = rows.map((row) => {
      const normalized: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(row)) {
        normalized[key.trim().toLowerCase()] = value;
      }

      return normalized;
    });

    const headers =
      normalizedRows.length > 0 ? Object.keys(normalizedRows[0]) : [];

    this.validateHeaders(headers);

    return {
      rows: normalizedRows,
      totalRows: normalizedRows.length,
      headers,
      errors: [],
    };
  }

  private validateHeaders(headers: string[]): void {
    const missing = REQUIRED_COLUMNS.filter(
      (required) => !headers.includes(required),
    );

    if (missing.length > 0) {
      throw new BadRequestException(
        `El archivo debe tener las columnas: ${REQUIRED_COLUMNS.join(', ')}. ` +
          `Faltan: ${missing.join(', ')}`,
      );
    }
  }
}
