import * as vscode from 'vscode';

const STORAGE_KEY = 'readingPositions';
const MAX_ENTRIES = 200;

/**
 * Last viewed position per file, as a pdf.js open-parameters hash
 * (`page=3&zoom=page-width,0,540`), kept across sessions.
 */
export class ReadingPositions {
  constructor(private readonly memento: vscode.Memento) {}

  public get(uri: vscode.Uri): string | undefined {
    return this.all()[uri.toString()];
  }

  public set(uri: vscode.Uri, position: string): void {
    const key = uri.toString();
    const positions = this.all();
    if (positions[key] === position) {
      return;
    }
    // Re-insert so key order runs from least to most recently viewed
    delete positions[key];
    positions[key] = position;
    const keys = Object.keys(positions);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
      delete positions[old];
    }
    this.memento.update(STORAGE_KEY, positions);
  }

  private all(): Record<string, string> {
    return { ...this.memento.get<Record<string, string>>(STORAGE_KEY, {}) };
  }
}
