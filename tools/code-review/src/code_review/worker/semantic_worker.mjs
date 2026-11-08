/* Minimal semantic adapter for the TypeScript 7 native compiler.
 *
 * TypeScript 7.0.2 ships no `tsc --lsp --stdio` mode. Its language-service
 * surface is the unstable programmatic API: `tsgo --api`, spawned by
 * `typescript/unstable/async`. This worker is the only place that knows the
 * wire details. It speaks newline-delimited JSON on stdin/stdout and is
 * driven by ../semantic.py.
 *
 * Ops:
 *   {op:"open", root, typescript, tsconfigs:[abs]}
 *   {op:"index", root, file, tsconfig}
 *   {op:"references", root, file, line, name, tsconfig, maxRefs}
 *   {op:"calls", root, file, startLine, endLine, tsconfig, maxEdges}
 *   {op:"close"}
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as readline from 'node:readline';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

function rel(root, p) {
  const abs = path.resolve(p);
  const base = path.resolve(root);
  return abs.startsWith(base + path.sep) ? abs.slice(base.length + 1).split(path.sep).join('/') : abs;
}

let state = null; // { root, api, snapshot, projects: Map<configPath, Project>, syntaxKind, is }

async function open(msg) {
  const tsRoot = path.dirname(require.resolve('typescript/package.json', { paths: [msg.typescript] }));
  const asyncPath = require.resolve('typescript/unstable/async', { paths: [tsRoot] });
  const astPath = require.resolve('typescript/unstable/ast', { paths: [tsRoot] });
  const isPath = require.resolve('typescript/unstable/ast/is', { paths: [tsRoot] });
  const { API } = await import(pathToFileURL(asyncPath).href);
  const SyntaxKind = (await import(pathToFileURL(astPath).href)).SyntaxKind;
  const is = await import(pathToFileURL(isPath).href);

  const api = new API({ cwd: msg.root });
  const snapshot = await api.updateSnapshot({ openProjects: msg.tsconfigs.map(String) });
  const projects = new Map();
  for (const project of snapshot.getProjects()) {
    projects.set(path.resolve(String(project.configFileName)), project);
  }
  const tsPkg = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(tsRoot, 'package.json'), 'utf8'),
  );
  state = { root: msg.root, api, snapshot, projects, tsVersion: tsPkg.version ?? 'unknown', SyntaxKind, is };
  return { ok: true, ts_version: state.tsVersion, projects: [...projects.keys()] };
}

function getProject(msg) {
  const project = state.projects.get(path.resolve(msg.tsconfig));
  if (!project) throw new Error(`project not open: ${msg.tsconfig}`);
  return project;
}

async function getSourceFile(project, absFile) {
  const sf = await project.program.getSourceFile(absFile);
  return sf;
}

function posOf(sf, line, character) {
  return sf.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, character ?? 0));
}

function lineChar(sf, pos) {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, character: lc.character };
}

const DECL_KIND_NAME = (SyntaxKind) =>
  new Map([
    [SyntaxKind.FunctionDeclaration, 'function'],
    [SyntaxKind.ClassDeclaration, 'class'],
    [SyntaxKind.InterfaceDeclaration, 'interface'],
    [SyntaxKind.TypeAliasDeclaration, 'type'],
    [SyntaxKind.EnumDeclaration, 'enum'],
    [SyntaxKind.ModuleDeclaration, 'module'],
    [SyntaxKind.MethodDeclaration, 'method'],
    [SyntaxKind.PropertyDeclaration, 'property'],
    [SyntaxKind.GetAccessor, 'accessor'],
    [SyntaxKind.SetAccessor, 'accessor'],
    [SyntaxKind.Constructor, 'constructor'],
    [SyntaxKind.VariableDeclaration, 'variable'],
  ]);

function hasModifier(SyntaxKind, node, kind) {
  return !!node.modifiers && node.modifiers.some((m) => m.kind === kind);
}

function enclosingName(sf, node) {
  let cur = node.parent;
  while (cur) {
    if (cur.name && typeof cur.name.getText === 'function') {
      const t = cur.name.getText(sf);
      if (t) return t;
    }
    cur = cur.parent;
  }
  return '';
}

function collectDeclarations(sf, SyntaxKind, root) {
  const decls = [];
  const imports = [];
  const reexports = [];
  const kindName = DECL_KIND_NAME(SyntaxKind);
  const ExportKeyword = SyntaxKind.ExportKeyword;

  const record = (node, name, kind, exported) => {
    if (!name) return;
    const start = node.getStart(sf);
    const end = node.getEnd();
    const s = lineChar(sf, start);
    const e = lineChar(sf, Math.max(start, end - 1));
    decls.push({
      name: String(name),
      kind,
      start_line: s.line,
      end_line: e.line,
      start_offset: start,
      end_offset: end,
      exported: !!exported,
      enclosing: enclosingName(sf, node),
      path: rel(root, sf.fileName ?? sf.path ?? ''),
    });
  };

  const visit = (node) => {
    const kind = node.kind;
    if (kind === SyntaxKind.ImportDeclaration) {
      const spec = node.moduleSpecifier;
      if (spec && spec.text) {
        const typeOnly = !!(node.importClause && node.importClause.isTypeOnly);
        imports.push({ module: spec.text, type_only: typeOnly, line: lineChar(sf, node.getStart(sf)).line });
      }
      return;
    }
    if (kind === SyntaxKind.ExportDeclaration) {
      const spec = node.moduleSpecifier ? node.moduleSpecifier.text : null;
      const typeOnly = !!node.isTypeOnly;
      let names = null;
      if (node.exportClause && node.exportClause.elements) {
        names = node.exportClause.elements.map((e) => e.name.getText(sf));
      }
      else if (node.exportClause && node.exportClause.name) {
        names = [node.exportClause.name.getText(sf)];
      }
      if (spec) reexports.push({ module: spec, names, type_only: typeOnly, line: lineChar(sf, node.getStart(sf)).line });
      return;
    }
    if (kind === SyntaxKind.ExportAssignment) {
      record(node, 'default', 'export-assignment', true);
      return;
    }
    if (kindName.has(kind) && kind !== SyntaxKind.VariableDeclaration) {
      const name = node.name ? node.name.getText(sf) : undefined;
      const enclosingExported = false;
      const exported = hasModifier(SyntaxKind, node, ExportKeyword) || enclosingExported;
      record(node, name, kindName.get(kind), exported);
    } else if (kind === SyntaxKind.VariableStatement) {
      const stmtExported = hasModifier(SyntaxKind, node, ExportKeyword);
      for (const declarator of node.declarationList.declarations) {
        if (declarator.name && declarator.name.expression === undefined) {
          const t = declarator.name.getText(sf);
          record(declarator, t, 'variable', stmtExported);
        }
      }
      return; // no nested descent needed for statements we already expanded
    }
    node.forEachChild(visit);
  };

  sf.forEachChild(visit);
  return { decls, imports, reexports };
}

async function opIndex(msg) {
  const project = getProject(msg);
  const absFile = path.resolve(msg.root, msg.file);
  const sf = await getSourceFile(project, absFile);
  if (!sf) return { ok: true, decls: [], imports: [], reexports: [], note: 'file not in program' };
  const { SyntaxKind } = state;
  const { decls, imports, reexports } = collectDeclarations(sf, SyntaxKind, msg.root);
  return { ok: true, decls, imports, reexports };
}

function deepestNodeAt(sf, predicate, pos) {
  let best = null;
  const visit = (node) => {
    if (node.getStart(sf) > pos || pos >= node.getEnd()) return;
    if (predicate(node)) best = node;
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return best;
}

async function handleToLocation(handle, root) {
  const node = await handle.resolve();
  if (!node) return null;
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const lc = sf.getLineAndCharacterOfPosition(start);
  return {
    path: rel(root, sf.fileName ?? String(handle.path)),
    line: lc.line + 1,
    character: lc.character,
    text: node.getText(sf).slice(0, 120),
  };
}

async function opReferences(msg) {
  const project = getProject(msg);
  const absFile = path.resolve(msg.root, msg.file);
  const sf = await getSourceFile(project, absFile);
  if (!sf) return { ok: true, definition: null, references: [], note: 'file not in program' };
  const checker = project.checker;
  let character = 0;
  if (msg.name) {
    const lineText = sf.text.split('\n')[Math.max(0, msg.line - 1)] ?? '';
    const idx = lineText.indexOf(msg.name);
    character = idx >= 0 ? idx + 1 : 0;
  }
  const position = posOf(sf, msg.line, character);
  const maxRefs = msg.maxRefs ?? 30;

  const identifier = deepestNodeAt(
    sf,
    (n) => n.kind === state.SyntaxKind.Identifier,
    position,
  );

  const symbol = await checker.getSymbolAtPosition(absFile, position);
  // getSymbolAtPosition on an imported identifier yields the import-alias
  // symbol (declared at the import site). Resolve the alias to the symbol
  // it stands for so the definition points at the real declaration.
  let definitionSymbol = symbol;
  if (symbol) {
    try {
      const aliased = await checker.getAliasedSymbol(symbol);
      if (aliased) definitionSymbol = aliased;
    } catch {
      // not an alias symbol — keep the original
    }
  }
  let definition = null;
  if (definitionSymbol && definitionSymbol.declarations && definitionSymbol.declarations.length) {
    const d = await handleToLocation(definitionSymbol.declarations[0], msg.root);
    if (d) {
      const declNode = await definitionSymbol.declarations[0].resolve();
      definition = { ...d, name: declNode && declNode.name ? declNode.name.getText(declNode.getSourceFile()) : (definitionSymbol.name ?? ''), kind: 'declaration' };
    }
  }

  const references = [];
  let truncated = false;
  let unresolved = 0;
  try {
    if (identifier) {
      const entries = await checker.getReferencedSymbolsForNode(identifier, position);
      for (const entry of entries ?? []) {
        for (const handle of entry.references ?? []) {
          if (references.length >= maxRefs) {
            truncated = true;
            continue;
          }
          try {
            const loc = await handleToLocation(handle, msg.root);
            if (loc) references.push(loc);
            else unresolved += 1;
          } catch {
            unresolved += 1;
          }
        }
      }
    }
  } catch (err) {
    return { ok: true, definition, references: [], truncated: false, unresolved, note: `references query failed: ${err && err.message ? err.message : String(err)}` };
  }
  return { ok: true, definition, references, truncated, unresolved };
}

async function opCalls(msg) {
  const project = getProject(msg);
  const absFile = path.resolve(msg.root, msg.file);
  const sf = await getSourceFile(project, absFile);
  if (!sf) return { ok: true, edges: [], unresolved_sites: 0, note: 'file not in program' };
  const checker = project.checker;
  const { SyntaxKind } = state;
  const start = posOf(sf, msg.startLine, 0);
  const end = msg.endLine ? posOf(sf, msg.endLine + 1, 0) : sf.getEnd();
  const maxEdges = msg.maxEdges ?? 500;
  const edges = [];
  let unresolvedSites = 0;
  let visited = 0;

  const findCalleeIdentifier = (callExpr) => {
    const callee = callExpr.expression;
    if (callee.kind === SyntaxKind.Identifier) return callee;
    if (callee.kind === SyntaxKind.PropertyAccessExpression && callee.name && callee.name.kind === SyntaxKind.Identifier) {
      return callee.name;
    }
    return null;
  };

  const visit = (node) => {
    if (node.getStart(sf) >= end) return;
    if (node.kind === SyntaxKind.CallExpression && node.getStart(sf) >= start) {
      visited += 1;
      const id = findCalleeIdentifier(node);
      if (!id) {
        unresolvedSites += 1;
      } else {
        edges.push({ callee: id.getText(sf), line: lineChar(sf, id.getStart(sf)).line, idOffset: id.getStart(sf) });
      }
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);

  const resolved = [];
  for (const edge of edges.slice(0, maxEdges)) {
    try {
      const symbol = await checker.getSymbolAtPosition(absFile, edge.idOffset + 1);
      if (!symbol || !symbol.declarations || symbol.declarations.length === 0) {
        resolved.push({ callee: edge.callee, line: edge.line, basis: 'candidate', target_path: null, target_line: null, target_name: null, note: 'unresolved callee' });
        continue;
      }
      const declNode = await symbol.declarations[0].resolve();
      if (!declNode) {
        resolved.push({ callee: edge.callee, line: edge.line, basis: 'candidate', target_path: null, target_line: null, target_name: null, note: 'declaration handle unresolvable' });
        continue;
      }
      const declSf = declNode.getSourceFile();
      const at = declNode.getStart(declSf);
      resolved.push({
        callee: edge.callee,
        line: edge.line,
        basis: symbol.declarations.length === 1 ? 'compiler-resolved' : 'candidate',
        target_path: rel(msg.root, declSf.fileName ?? String(declNode.path ?? '')),
        target_line: declSf.getLineAndCharacterOfPosition(at).line + 1,
        target_name: declNode.name ? declNode.name.getText(declSf) : (symbol.name ?? null),
      });
    } catch (err) {
      resolved.push({ callee: edge.callee, line: edge.line, basis: 'candidate', target_path: null, target_line: null, target_name: null, note: String(err && err.message ? err.message : err) });
    }
  }
  return { ok: true, edges: resolved, unresolved_sites: unresolvedSites, visited_calls: visited, truncated: edges.length > maxEdges };
}

const ops = { open, index: opIndex, references: opReferences, calls: opCalls };

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: `bad request: ${err.message}` }) + '\n');
    return;
  }
  if (msg.op === 'close') {
    try {
      if (state && state.snapshot) await state.snapshot.dispose();
      if (state && state.api) await state.api.close();
    } catch {
      /* best effort */
    }
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    process.exit(0);
  }
  const handler = ops[msg.op];
  if (!handler) {
    process.stdout.write(JSON.stringify({ ok: false, error: `unknown op: ${msg.op}` }) + '\n');
    return;
  }
  try {
    const result = await handler(msg);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: `${err && err.message ? err.message : String(err)}` }) + '\n');
  }
});
