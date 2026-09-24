import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PdfPreview } from '../../pdfPreview';

// Minimal PDF whose bytes differ per version
function makePdf(version: string): Buffer {
  const text = `BT /F1 24 Tf 72 700 Td (${version}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let data = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(data.length);
    data += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = data.length;
  data += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  data += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  data += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data, 'latin1');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await sleep(20);
  }
  return check();
}

function isPreviewOpen(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.uri.toString() === uri.toString()
    )
  );
}

// Record messages sent to every preview's webview
const reloads: string[] = [];
const deleted: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = PdfPreview.prototype as any;
const originalPost = proto.postToWebview;
proto.postToWebview = function (this: { resource: vscode.Uri }, type: string): void {
  if (type === 'reload') {
    reloads.push(this.resource.fsPath);
  } else if (type === 'deleted') {
    deleted.push(this.resource.fsPath);
  }
  originalPost.call(this, type);
};

suite('Reload on file changes', function () {
  this.timeout(20000);
  // Outside of any workspace folder
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-test-'));

  async function openPreview(name: string): Promise<{ file: string; uri: vscode.Uri }> {
    const file = path.join(dir, name);
    fs.writeFileSync(file, makePdf('v1'));
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'pdf.preview');
    assert.ok(await waitFor(() => isPreviewOpen(uri), 5000), 'preview did not open');
    // Let the watcher start
    await sleep(1000);
    reloads.length = 0;
    return { file, uri };
  }

  async function expectReload(file: string, what: string): Promise<number> {
    const start = Date.now();
    assert.ok(
      await waitFor(() => reloads.includes(file), 5000),
      `no reload after ${what}`
    );
    const latency = Date.now() - start;
    console.log(`    reload after ${what}: ${latency}ms`);
    reloads.length = 0;
    return latency;
  }

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('reloads when the file is rewritten in place', async () => {
    const { file } = await openPreview('in-place.pdf');
    fs.writeFileSync(file, makePdf('v2'));
    await expectReload(file, 'in-place write');
    // The slower VS Code watcher reports the same write again
    await sleep(1500);
    assert.deepStrictEqual(reloads, [], 'reloaded twice for one write');
  });

  test('reloads and stays open when the file is deleted and recreated', async () => {
    const { file, uri } = await openPreview('recreated.pdf');
    fs.unlinkSync(file);
    await sleep(200);
    fs.writeFileSync(file, makePdf('v2'));
    await expectReload(file, 'delete + recreate');
    await sleep(1500);
    assert.ok(isPreviewOpen(uri), 'preview was closed');
  });

  test('reloads when the file is replaced by a rename', async () => {
    const { file, uri } = await openPreview('renamed.pdf');
    const tmp = path.join(dir, 'renamed.pdf.tmp');
    fs.writeFileSync(tmp, makePdf('v2'));
    fs.renameSync(tmp, file);
    await expectReload(file, 'rename over');
    await sleep(1500);
    assert.ok(isPreviewOpen(uri), 'preview was closed');
  });

  test('handles glob characters in the file name', async () => {
    const { file } = await openPreview('paper [draft] {1}.pdf');
    fs.writeFileSync(file, makePdf('v2'));
    await expectReload(file, 'write to a file with glob characters');
  });

  test('ignores other files in the folder', async () => {
    const { file } = await openPreview('quiet.pdf');
    fs.writeFileSync(path.join(dir, 'other.pdf'), makePdf('v2'));
    await sleep(1500);
    assert.ok(!reloads.includes(file), 'reloaded for an unrelated file');
  });

  test('stays open when the file is deleted, and reloads when it returns', async () => {
    const { file, uri } = await openPreview('deleted.pdf');
    fs.unlinkSync(file);
    assert.ok(await waitFor(() => deleted.includes(file), 5000), 'deletion not reported');
    assert.ok(isPreviewOpen(uri), 'preview was closed');
    fs.writeFileSync(file, makePdf('v2'));
    await expectReload(file, 'recreate after deletion');
  });

  test('reloads when the whole folder is removed and recreated', async () => {
    const sub = path.join(dir, 'build');
    fs.mkdirSync(sub);
    const { file } = await openPreview(path.join('build', 'out.pdf'));
    fs.rmdirSync(sub, { recursive: true });
    assert.ok(await waitFor(() => deleted.includes(file), 5000), 'deletion not reported');
    fs.mkdirSync(sub);
    fs.writeFileSync(file, makePdf('v2'));
    await expectReload(file, 'folder recreated');
  });
});
