import { Injectable, BadRequestException } from '@nestjs/common';
import * as xlsx from 'xlsx';
import * as Papa from 'papaparse';
import { ConfigService } from '@nestjs/config';

export interface FileParseResult {
  rows: Record<string, unknown>[];
  totalRows: number;
  headers: string[];
  errors: Array<{ row: number; message: string }>;
}

const REQUIRED_COLUMNS = ['address', 'channel'];
const DEFAULT_MAX_ROWS = 5000;

@Injectable()
export class FileParserService {
  constructor(private readonly config: ConfigService) {}

  parse(
    buffer: Buffer,
    mimetype: string,
    originalName: string,
  ): FileParseResult {
    const extension = originalName.split('.').pop()?.toLocaleLowerCase();

    let result: FileParseResult;

    if (
      mimetype === 'text/csv' ||
      mimetype === 'application/csv' ||
      extension === 'csv'
    ) {
      result = this.parseCsv(buffer);
    } else if (
      mimetype ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimetype === 'application/vnd.ms-excel' ||
      extension === 'xlsx' ||
      extension === 'xls'
    ) {
      result = this.parseExcel(buffer);
    } else {
      throw new BadRequestException(
        `Formato no soportado: ${mimetype}. Usa CSV o Excel (.xlsx/.xls)`,
      );
    }

    this.validateRowCount(result.totalRows);
    return result;
  }

  rowsToPayloads(
    rows: Record<string, unknown>[],
    templateId: string,
    extraVariables: Record<string, unknown>,
    scheduledAt: string,
    priority?: 'low' | 'normal' | 'high',
    connectionId?: string,
  ): unknown[] {
    return rows.map((row) => {
      const { address, channel, name, ...templateVariables } = row;

      return {
        recipient: {
          channel: String(channel).toUpperCase(),
          address: String(address),
          ...(name ? { name: String(name) } : {}),
        },
        template: { id: templateId },
        connectionId,
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
      throw new BadRequestException('excel file dont has sheets');
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

  private validateRowCount(rowCount: number): void {
    const maxRows =
      this.config.get<number>('messaging.maxFileUploadRows') ??
      DEFAULT_MAX_ROWS;

    if (rowCount > maxRows) {
      throw new BadRequestException(
        `El archivo contiene ${rowCount} filas, supera el límite de ${maxRows} ` +
          'por carga. Dividí el archivo en lotes más pequeños.',
      );
    }
  }
}
