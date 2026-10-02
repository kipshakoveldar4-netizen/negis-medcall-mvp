import path from "node:path";
import ts from "typescript";

export type CrmSources = ReadonlyMap<string, string>;

const modelFile = "lib/siteInquiryDeletion.ts";
const componentFile = "components/crm/site-inquiry-deletion.tsx";
const pageFile = "pages/LeadsPage.tsx";
const factoryName = "createSiteInquiryDeletion";
const componentName = "SiteInquiryDeletion";

function modulePath(file: string, specifier: string): string {
  return (specifier.startsWith("@/") ? specifier.slice(2)
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))).replace(/\.tsx?$/, "");
}

// This is one audited injection boundary, not a global exemption for `request`.
// New aliases, callers or forwarding shapes fail closed and need explicit review.
function hasVerifiedDeletionTransport(sources: CrmSources): boolean {
  let valid = true;
  let factoryDeclarations = 0, componentDeclarations = 0, factoryCalls = 0, mounts = 0, requests = 0;
  let apiImports = 0, factoryImports = 0, componentImports = 0;
  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const inFunction = (node: ts.Node, name: string): boolean => {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent)) return parent.name?.text === name;
      }
      return false;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) {
        const target = modulePath(file, node.text);
        if (target === modelFile.replace(/\.ts$/, "") || target === componentFile.replace(/\.tsx$/, "")) {
          const parent = node.parent;
          const expectedFile = target.startsWith("lib/") ? componentFile : pageFile;
          const expectedName = target.startsWith("lib/") ? factoryName : componentName;
          const imports = ts.isImportDeclaration(parent) ? parent.importClause : undefined;
          const bindings = imports?.namedBindings;
          if (file !== expectedFile || imports?.isTypeOnly || imports?.name || !bindings || !ts.isNamedImports(bindings)
            || !bindings.elements.some((entry) => !entry.isTypeOnly && entry.name.text === expectedName && !entry.propertyName)) valid = false;
        }
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (node.text === factoryName || node.text === componentName) {
          const factory = node.text === factoryName;
          const definitionFile = factory ? modelFile : componentFile;
          const callerFile = factory ? componentFile : pageFile;
          if (file === definitionFile && ts.isFunctionDeclaration(parent) && parent.name === node) {
            if (factory) {
              factoryDeclarations++;
              const parameter = parent.parameters[2];
              if (!parameter || parameter.name.getText(ast) !== "request" || parameter.initializer) valid = false;
            } else componentDeclarations++;
          } else if (file === callerFile && ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName && !parent.isTypeOnly) {
            const declaration = parent.parent.parent.parent;
            if (!ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier)
              || modulePath(file, declaration.moduleSpecifier.text) !== definitionFile.replace(/\.tsx?$/, "")) valid = false;
            if (factory) factoryImports++; else componentImports++;
          } else if (factory && file === componentFile && ts.isCallExpression(parent) && parent.expression === node
            && inFunction(node, componentName)) {
            factoryCalls++;
            if (parent.arguments[2]?.getText(ast) !== "request") valid = false;
          } else if (!factory && file === pageFile && ts.isJsxSelfClosingElement(parent) && parent.tagName === node) {
            mounts++;
            const attributes = parent.attributes.properties;
            const request = attributes.filter(ts.isJsxAttribute).filter((attribute) => attribute.name.getText(ast) === "request");
            if (attributes.some(ts.isJsxSpreadAttribute) || request.length !== 1
              || request[0].initializer?.getText(ast) !== "{crmFetch}") valid = false;
          } else valid = false;
        }
        if (node.text === "crmFetch" && file === pageFile) {
          if (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName) {
            const declaration = parent.parent.parent.parent;
            if (!ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier)
              || modulePath(file, declaration.moduleSpecifier.text) !== "lib/api") valid = false;
            apiImports++;
          } else if (!(ts.isCallExpression(parent) && parent.expression === node) && !ts.isJsxExpression(parent)) valid = false;
        }
        if (node.text === "request" && file === modelFile) {
          if (ts.isParameter(parent) && parent.name === node && inFunction(node, factoryName)) {
            if (!ts.isFunctionDeclaration(parent.parent) || parent !== parent.parent.parameters[2]) valid = false;
          } else if (ts.isCallExpression(parent) && parent.expression === node && inFunction(node, factoryName)) requests++;
          else valid = false;
        }
        if (node.text === "request" && file === componentFile) {
          if (ts.isBindingElement(parent) && parent.name === node && ts.isObjectBindingPattern(parent.parent)
            && ts.isParameter(parent.parent.parent) && inFunction(node, componentName)) {
            if (parent.propertyName || parent.initializer || parent.dotDotDotToken || parent.parent.parent.initializer) valid = false;
          } else if (ts.isPropertySignature(parent) && parent.name === node) {
            // The prop type is not a value or transport implementation.
          } else if (ts.isCallExpression(parent) && parent.expression.getText(ast) === factoryName && parent.arguments[2] === node) {
            // The only forwarding call validated above.
          } else if (ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent)
            && parent.parent.expression.getText(ast) === "useMemo" && parent.parent.arguments[1] === parent) {
            // React dependency only; cannot forward or replace the request.
          } else valid = false;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return valid && factoryDeclarations === 1 && componentDeclarations === 1 && factoryCalls === 1
    && mounts === 1 && requests === 2 && apiImports === 1 && factoryImports === 1 && componentImports === 1;
}

export function crmTransportOffenders(sources: CrmSources): string[] {
  const injectedDeletionIsSafe = hasVerifiedDeletionTransport(sources);
  const sharedHelpers = new Set(["crmFetch", "crmRequest", "crmJson"]);
  const offenders: string[] = [];
  for (const [name, source] of sources) {
    if (name === "lib/api.ts") continue;
    const receivers = new Set<string>();
    for (const match of source.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?\s*\(\s*[`"'][^`"']*\/api\/crm\//g)) receivers.add(match[1]);
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true,
      name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const locals: { name: string; calls: Set<string> }[] = [];
    const addLocal = (localName: string, body: ts.Node) => {
      const calls = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text);
        ts.forEachChild(node, visit);
      };
      visit(body);
      locals.push({ name: localName, calls });
    };
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) addLocal(node.name.text, node.body);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        addLocal(node.name.text, node.initializer.body);
      }
      ts.forEachChild(node, collect);
    };
    collect(ast);
    const localNames = new Set(locals.map((local) => local.name));
    const imported = (source.match(/import \{([^}]*)\} from ["']@\/lib\/api["']/)?.[1] ?? "")
      .split(",").map((entry) => entry.trim()).filter((entry) => sharedHelpers.has(entry) && !localNames.has(entry));
    const safe = new Set(imported);
    if (name === modelFile && injectedDeletionIsSafe) safe.add("request");
    for (let pass = 0; pass < locals.length + 1; pass += 1) {
      let grew = false;
      for (const local of locals) {
        if (!safe.has(local.name) && !local.calls.has("fetch") && [...safe].some((known) => local.calls.has(known))) {
          safe.add(local.name);
          grew = true;
        }
      }
      if (!grew) break;
    }
    for (const helper of receivers) {
      if (helper === "fetch") offenders.push(name + ": a CRM path is handed straight to fetch");
      else if (!safe.has(helper)) offenders.push(name + ": CRM paths flow through " + helper + ", which never reaches crmFetch");
    }
    if (name === modelFile && !injectedDeletionIsSafe) offenders.push(name + ": unverified injected transport chain");
  }
  return offenders;
}
