import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import ts from 'typescript';

const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) throw new Error('Expected chrome or firefox');
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', target);
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCurrentDirectory: () => root, getCanonicalFileName: x => x, getNewLine: () => '\n'
}));
const sourceRoot = path.join(root, 'src');
const emitter = ts.createProgram(parsed.fileNames.filter(file => path.resolve(file).startsWith(sourceRoot + path.sep)), {
  ...parsed.options, noEmit: false, rootDir: sourceRoot, outDir: out, inlineSourceMap: false, sourceMap: false
});
if (emitter.emit().emitSkipped) throw new Error('TypeScript emission failed');

async function copy(dir, relative = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) await copy(source, name);
    else if (!/\.ts$|\.js$|\.map$/.test(name) || name.startsWith(`libs${path.sep}`)) {
      const destination = path.join(out, name.replace(/\.ts$/, '.js'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
  }
}
await copy(path.join(root, 'src'));
const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
if (target === 'chrome') {
  manifest.manifest_version = 3;
  manifest.minimum_chrome_version = '116';
  manifest.background = { service_worker: 'chrome-worker.js' };
  manifest.host_permissions = manifest.permissions.filter(x => x === '<all_urls>');
  manifest.permissions = manifest.permissions.filter(x => !['<all_urls>', 'search'].includes(x));
  manifest.permissions.push('scripting', 'offscreen');
  manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== 'downloads');
  manifest.web_accessible_resources = [{ resources: manifest.web_accessible_resources, matches: ['<all_urls>'] }];
  delete manifest.applications;
  delete manifest.options_ui.browser_style;
  await fs.copyFile(path.join(root, 'node_modules/webextension-polyfill/dist/browser-polyfill.js'), path.join(out, 'libs/browser-polyfill.js'));
  await fs.copyFile(path.join(root, 'node_modules/webextension-polyfill/LICENSE'), path.join(out, 'libs/browser-polyfill.LICENSE'));
  const content = await Promise.all(['libs/browser-polyfill.js', 'content-scripts/selectionchange.js', 'content-scripts/page-script.js'].map(name => fs.readFile(path.join(out, name), 'utf8')));
  await fs.writeFile(path.join(out, 'content-scripts/entry.js'), `(function () { if (globalThis.__sssContentInstalled) return false; globalThis.__sssContentInstalled = true; try {\n${content.join('\n')}\nreturn true; } catch (error) { delete globalThis.__sssContentInstalled; throw error; } })();\n`);
  // The vendored Browserify entry explicitly assigns window.iconv; workers have no window.
  await build({ entryPoints: [path.join(root, 'src/libs/iconv-lite.js')], outfile: path.join(out, 'libs/iconv-lite.js'), define: { window: 'globalThis' }, legalComments: 'inline' });
  for (const html of ['settings/settings.html', 'swift-selection-search.html']) {
    const file = path.join(out, html);
    const prefix = html.startsWith('settings/') ? '../' : '';
    let content = (await fs.readFile(file, 'utf8')).replace('<head>', `<head>\n<script src="${prefix}libs/browser-polyfill.js"></script>`);
    if (html === 'settings/settings.html') {
      content = content
        .replaceAll('Firefox Sync', 'browser sync')
        .replaceAll("wait for Firefox to sync or force the sync yourself from Firefox's menu", 'wait for your browser to sync');
    }
    await fs.writeFile(file, content);
  }
  await fs.writeFile(path.join(out, 'chrome-worker.js'), `importScripts('libs/browser-polyfill.js', 'libs/iconv-lite.js', 'browser-compat.js', 'search-variable-modifications.js', 'swift-selection-search.js');\n`);
  await fs.rm(path.join(out, 'swift-selection-search.html'));
} else {
  await fs.rm(path.join(out, 'offscreen.html'));
  await fs.rm(path.join(out, 'offscreen.js'));
}
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${out}`);
if (process.argv.includes('--zip')) {
  const files = {};
  async function collect(dir, prefix = '') {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + e.name;
      if (e.isDirectory()) await collect(path.join(dir, e.name), name + '/');
      else files[name] = new Uint8Array(await fs.readFile(path.join(dir, e.name)));
    }
  }
  await collect(out);
  const zip = path.join(root, 'dist', `swift-selection-search-${target}-${manifest.version}.zip`);
  await fs.writeFile(zip, zipSync(files));
  console.log(`Packaged ${zip}`);
}
