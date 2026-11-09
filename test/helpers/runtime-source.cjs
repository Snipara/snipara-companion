const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadRuntimeSource(file) {
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  const original = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === '../contracts/project-intelligence') {
      return loadRuntimeSource(path.resolve(__dirname, '../../src/contracts/project-intelligence/managed-toolchain.ts'));
    }
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(file), name + '.ts');
      if (fs.existsSync(target)) return loadRuntimeSource(target);
    }
    return original(name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText, file);
  return loaded.exports;
}
module.exports = {loadRuntimeSource};
