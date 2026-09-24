import * as vscode from 'vscode';
import { PdfCustomProvider } from './pdfProvider';
import { ReadingPositions } from './readingPositions';

export function activate(context: vscode.ExtensionContext): void {
  const extensionRoot = vscode.Uri.file(context.extensionPath);
  // Register our custom editor provider
  const provider = new PdfCustomProvider(
    extensionRoot,
    new ReadingPositions(context.globalState)
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfCustomProvider.viewType,
      provider,
      {
        webviewOptions: {
          enableFindWidget: false, // default
          retainContextWhenHidden: true,
        },
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('pdf.print', () => {
      provider.activePreview?.print();
    })
  );
}

export function deactivate(): void {}
