const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Use the shipping catalog even in classic-script VM tests, never a parallel
// test dictionary that could pass while the extension has missing translations.
const root = path.resolve(__dirname, '../..');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'src/messages/i18n.js'), 'utf8').replace(/^export /gm, '')
  + '\nglobalThis.translate = createTranslator; globalThis.catalog = STRINGS;', context);
vm.runInContext(fs.readFileSync(path.join(root, 'src/features/export/engine/i18n.js'), 'utf8'), context);

module.exports = {
  translator: context.translate,
  catalog: context.catalog,
  exportMessages: (language = 'zh-CN') => context.TidyExport.createExportMessages(context.translate(language)),
};
