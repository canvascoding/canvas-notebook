import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Execute current source with explicit dependencies; never fall through to a real DB/env. */
export function evaluateIsolatedModule<T>(
  source: string,
  mocks: Record<string, unknown>,
  globals: Record<string, unknown> = {},
): T {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {};
  const requireMock = (name: string) => {
    if (!Object.hasOwn(mocks, name)) throw new Error(`Unexpected test dependency: ${name}`);
    return mocks[name];
  };
  new Function('require', 'module', 'exports', ...Object.keys(globals), compiled.outputText)(
    requireMock, { exports: exported }, exported, ...Object.values(globals),
  );
  return exported as T;
}

export function loadIsolatedModule<T>(
  file: string,
  mocks: Record<string, unknown>,
  globals: Record<string, unknown> = {},
): T {
  return evaluateIsolatedModule<T>(readFileSync(file, 'utf8'), mocks, globals);
}

export function sourceFunction(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declaration) throw new Error(`Missing source function: ${name}`);
  return `${declaration.getText(source)}\nexports.${name} = ${name};`;
}
