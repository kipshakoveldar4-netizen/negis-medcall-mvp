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

// Validate the admin page's one session-bound injection before accepting its alias.
function hasVerifiedAdminTransport(sources: CrmSources): boolean {
  let valid = true, imports = 0, calls = 0, mounts = 0, sessions = 0, contents = 0, aliases = 0, wrappers = 0;
  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inFunction = (node: ts.Node, name: string) => {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent)) return parent.name?.text === name;
      }
      return false;
    };
    const visit = (node: ts.Node): void => {
      if (file === 'pages/AdminCenter.tsx') {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'AdminCenterSession') sessions++;
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'AdminCenterContent') {
          contents++;
          const param = node.parameters[0];
          if (node.parameters.length !== 1 || param.initializer || param.name.getText(ast) !== '{ access }') valid = false;
        }
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'request' && inFunction(node, 'AdminCenterSession')) {
          wrappers++;
          if (!node.initializer || !ts.isArrowFunction(node.initializer)) valid = false;
        }
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'crmFetch') {
          aliases++;
          if (!inFunction(node, 'AdminCenterContent') || node.initializer?.getText(ast) !== 'access.request'
            || !ts.isVariableDeclarationList(node.parent) || !(node.parent.flags & ts.NodeFlags.Const)) valid = false;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          && /^(access|crmFetch|request)(\.|\[|$)/.test(node.left.getText(ast))) valid = false;
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'fetch'
          && (inFunction(node, 'AdminCenterSession') || inFunction(node, 'AdminCenterContent'))) valid = false;
      }
      if (ts.isIdentifier(node) && node.text === 'sendCrmFetch') {
        const parent = node.parent;
        if (file !== 'pages/AdminCenter.tsx') valid = false;
        else if (ts.isImportSpecifier(parent) && parent.name === node) {
          const declaration = parent.parent.parent.parent;
          imports++;
          if (parent.isTypeOnly || parent.propertyName?.text !== 'crmFetch' || !ts.isImportDeclaration(declaration)
            || !ts.isStringLiteral(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== '@/lib/api') valid = false;
        } else if (ts.isTypeQueryNode(parent)) {
          // Type annotation, not a replaceable value.
        } else if (ts.isCallExpression(parent) && parent.expression === node && inFunction(node, 'AdminCenterSession')) {
          calls++;
          if (parent.arguments[0]?.getText(ast) !== 'path') valid = false;
        } else valid = false;
      }
      if (ts.isIdentifier(node) && node.text === 'AdminCenterContent') {
        const parent = node.parent;
        if (file !== 'pages/AdminCenter.tsx') valid = false;
        else if (ts.isFunctionDeclaration(parent) && parent.name === node) {
          // Declaration checked above.
        } else if (ts.isJsxSelfClosingElement(parent) && parent.tagName === node && inFunction(node, 'AdminCenterSession')) {
          mounts++;
          const attributes = parent.attributes.properties;
          const access = attributes.filter(ts.isJsxAttribute).filter((attribute) => attribute.name.getText(ast) === 'access');
          const initializer = access[0]?.initializer;
          const object = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
          if (attributes.some(ts.isJsxSpreadAttribute) || access.length !== 1 || !object || !ts.isObjectLiteralExpression(object)) valid = false;
          else {
            const requests = object.properties.filter((property) => property.name?.getText(ast) === 'request');
            if (object.properties.some(ts.isSpreadAssignment) || requests.length !== 1 || !ts.isShorthandPropertyAssignment(requests[0])) valid = false;
          }
        } else valid = false;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return valid && imports === 1 && calls === 1 && mounts === 1 && sessions === 1 && contents === 1 && aliases === 1 && wrappers === 1;
}

const mortgageFile = "lib/mortgage-workspace.tsx";
const mortgageAnalyticsFile = "pages/MortgageAnalytics.tsx";

// Prove this context -> hook -> consumer chain, not the names `request` or
// `mutate`. Only the exact call sites below receive an exemption.
function verifiedMortgageReceivers(sources: CrmSources): Map<string, Set<number>> | undefined {
  const files = new Map([...sources].filter(([file]) => file === mortgageFile || file === mortgageAnalyticsFile)
    .map(([file, source]) => [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));
  const model = files.get(mortgageFile);
  if (!model) return undefined;
  // Binding identities distinguish a verified closure from a same-named shadow.
  const program = ts.createProgram([...files.keys()], { noLib: true, noResolve: true }, {
    getSourceFile: (file) => files.get(file), getDefaultLibFileName: () => "", writeFile: () => {},
    getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (file) => files.has(file),
    readFile: (file) => sources.get(file), getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  });
  const checker = program.getTypeChecker();
  const nodes = (root: ts.Node): ts.Node[] => {
    const result: ts.Node[] = [];
    const visit = (node: ts.Node) => { result.push(node); ts.forEachChild(node, visit); };
    visit(root);
    return result;
  };
  const one = <T,>(values: T[]): T | undefined => values.length === 1 ? values[0] : undefined;
  const symbol = (node: ts.Node) => ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent) : checker.getSymbolAtLocation(node);
  const boundTo = (node: ts.Node, name: ts.Node) => Boolean(symbol(name)) && symbol(node) === symbol(name);
  const references = (name: ts.Node, allowed: (node: ts.Identifier) => boolean) => [...files.values()]
    .every((ast) => nodes(ast).filter(ts.isIdentifier).filter((node) => boundTo(node, name)).every(allowed));
  const fingerprint = (node: ts.Node): unknown[] => {
    const children: unknown[] = [];
    ts.forEachChild(node, (child) => { children.push(fingerprint(child)); });
    return [node.kind, ts.isIdentifier(node) || ts.isLiteralExpression(node) ? node.text : null,
      ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : null, children];
  };
  const matches = (node: ts.Node | undefined, text: string) => {
    if (!node) return false;
    const parse = (source: string) => ts.createSourceFile("proof.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expected: ts.Node | undefined;
    if (ts.isBlock(node)) expected = parse(text).statements[0];
    else if (ts.isJsxExpression(node)) {
      const statement = parse(`const proof = <Proof value=${text} />;`).statements[0] as ts.VariableStatement;
      expected = ((statement.declarationList.declarations[0].initializer as ts.JsxSelfClosingElement)
        .attributes.properties[0] as ts.JsxAttribute).initializer;
    } else {
      const statement = parse(ts.isObjectBindingPattern(node) ? `const ${text} = {};` : `const proof = ${text};`).statements[0] as ts.VariableStatement;
      const declaration = statement.declarationList.declarations[0];
      expected = ts.isObjectBindingPattern(node) ? declaration.name : declaration.initializer;
    }
    return Boolean(expected) && JSON.stringify(fingerprint(node)) === JSON.stringify(fingerprint(expected!));
  };
  const constant = (node: ts.VariableDeclaration) => ts.isVariableDeclarationList(node.parent)
    && Boolean(node.parent.flags & ts.NodeFlags.Const);
  const variable = (root: ts.Node, name: string) => one(nodes(root).filter(ts.isVariableDeclaration)
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === name && constant(node)));
  const declaration = (name: string) => one(model.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name?.text === name));
  const returnsFrom = (fn: ts.FunctionDeclaration) => nodes(fn).filter(ts.isReturnStatement).filter((node) => {
    let parent: ts.Node | undefined = node.parent;
    while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
    return parent === fn;
  });
  const imported = (ast: ts.SourceFile, name: string, from: string) => one(nodes(ast).filter(ts.isImportSpecifier).filter((node) => {
    const parent = node.parent.parent.parent;
    return node.name.text === name && !node.propertyName && !node.isTypeOnly && ts.isImportDeclaration(parent)
      && !parent.importClause?.isTypeOnly && ts.isStringLiteral(parent.moduleSpecifier)
      && modulePath(ast.fileName, parent.moduleSpecifier.text) === modulePath(ast.fileName, from);
  }));
  const dependency = (node: ts.Node) => ts.isArrayLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent)
    && node.parent.parent.arguments[1] === node.parent;
  const readOnlyProperty = (node: ts.Identifier) => {
    let parent: ts.Node = node;
    while (ts.isPropertyAccessExpression(parent.parent) && parent.parent.expression === parent) parent = parent.parent;
    return parent !== node && !(ts.isBinaryExpression(parent.parent) && parent.parent.left === parent
      && parent.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      && !ts.isDeleteExpression(parent.parent) && !ts.isPostfixUnaryExpression(parent.parent)
      && !(ts.isPrefixUnaryExpression(parent.parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.parent.operator));
  };
  const scope = declaration("MortgageScope"), session = declaration("MortgageSession"), hook = declaration("useMortgageWorkspace");
  const context = variable(model, "MortgageContext");
  const crm = imported(model, "crmFetch", "@/lib/api");
  if (!scope?.body || !session?.body || !hook?.body || !context || !crm
    || !matches(context.initializer, "createContext<Access | null>(null)")) return undefined;
  if (session.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword)
    || (ts.isVariableStatement(context.parent.parent) && context.parent.parent.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword))
    || !matches(session.parameters[0]?.name, "{ scope, live, children }") || session.parameters[0].initializer) return undefined;
  if (!references(hook.name!, (node) => node === hook.name)) return undefined;
  for (const name of ["createContext", "useContext", "useMemo", "useCallback", "useRef"]) {
    const binding = imported(model, name, "react");
    if (!binding || !nodes(model).filter(ts.isCallExpression).filter((node) => ts.isIdentifier(node.expression) && node.expression.text === name)
      .every((node) => boundTo(node.expression, binding.name)) || !references(binding.name, (node) => node === binding.name
        || (ts.isCallExpression(node.parent) && node.parent.expression === node))) return undefined;
  }
  const auth = imported(model, "useAuth", "@/contexts/AuthContext");
  const authCall = one(nodes(scope).filter(ts.isCallExpression).filter((node) => auth && boundTo(node.expression, auth.name)));
  if (!auth || !authCall || !ts.isVariableDeclaration(authCall.parent)
    || !matches(authCall.parent.name, "{ user, userRole, clinicId, workspacePurpose, isLoading, isSigningOut, isDemoMode, isImpersonation }")) return undefined;
  const scopeValue = variable(scope, "scope"), live = variable(scope, "live"), captured = variable(session, "captured");
  if (!scopeValue || !live || !captured || !matches(captured.initializer, "useRef(scope).current")
    || !matches(live.initializer, "useRef(scope)") || !matches(scopeValue.initializer, `{
      actorId: !isLoading && !isSigningOut && !isDemoMode && !isImpersonation ? user?.id || "" : "",
      workspaceId: userRole === "lead_manager" ? clinicId || "" : clinicId || readWorkspaceId(),
      role: userRole, purpose: workspacePurpose,
    }`)) return undefined;
  const sessionMount = one(nodes(scope).filter(ts.isJsxOpeningElement).filter((node) => node.tagName.getText() === "MortgageSession"));
  if (!sessionMount || sessionMount.attributes.properties.some(ts.isJsxSpreadAttribute)) return undefined;
  for (const [name, value] of [["scope", "{scope}"], ["live", "{live}"]] as const) {
    const attr = one(sessionMount.attributes.properties.filter(ts.isJsxAttribute).filter((node) => node.name.getText() === name));
    if (!matches(attr?.initializer, value)) return undefined;
  }
  if (!references(scopeValue.name, (node) => node === scopeValue.name || readOnlyProperty(node)
    || (ts.isCallExpression(node.parent) && node.parent.expression.getText() === "useRef")
    || (ts.isBinaryExpression(node.parent) && node.parent.right === node && matches(node.parent, "live.current = scope"))
    || (ts.isJsxExpression(node.parent) && node.parent.parent.parent === sessionMount.attributes))) return undefined;
  if (!references(session.name!, (node) => node === session.name
    || ((ts.isJsxOpeningElement(node.parent) || ts.isJsxClosingElement(node.parent)) && node.parent.tagName === node && node.parent.parent === sessionMount.parent))) return undefined;
  if (!references(captured.name, (node) => node === captured.name || readOnlyProperty(node) || dependency(node))) return undefined;
  const access = variable(session, "access");
  if (!access?.initializer || !ts.isCallExpression(access.initializer) || access.initializer.expression.getText() !== "useMemo") return undefined;
  const factory = access.initializer.arguments[0];
  // Pin the small security-critical factory, including actor binding, init order,
  // cancellation and denial. Comments/neighboring calls cannot prove delegation.
  if (!factory || !ts.isArrowFunction(factory) || factory.parameters.length !== 0 || !matches(factory.body, `{
    if (!lifetime) return null;
    const { controller } = lifetime;
    const isCurrent = () => Boolean(captured.actorId && captured.workspaceId
      && live.current.actorId === captured.actorId && live.current.workspaceId === captured.workspaceId
      && live.current.role === captured.role && live.current.purpose === captured.purpose
      && sessionRef.current === controller && !controller.signal.aborted && !invalidated.current);
    const request = async (path: string, init?: RequestInit) => {
      if (!isCurrent()) throw ended();
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
      signal.throwIfAborted();
      const response = await crmFetch(path, { ...init, cache: "no-store", expectedUserId: captured.actorId, signal });
      if (!isCurrent()) throw ended();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        invalidated.current = response.status === 401 ? "expired" : response.status === 403 ? "denied" : "missing";
        controller.abort();
        setRevoked(invalidated.current);
        throw ended();
      }
      signal.throwIfAborted();
      return response;
    };
    return { workspaceId: captured.workspaceId, isCurrent, request };
  }`)) return undefined;
  const crmCall = one(nodes(factory).filter(ts.isCallExpression).filter((node) => boundTo(node.expression, crm.name)));
  if (!crmCall || !references(crm.name, (node) => node === crm.name || node === crmCall.expression)) return undefined;
  const provider = one(nodes(session).filter(ts.isJsxOpeningElement).filter((node) => node.tagName.getText() === "MortgageContext.Provider"));
  if (!provider || provider.attributes.properties.some(ts.isJsxSpreadAttribute)
    || !matches(one(provider.attributes.properties.filter(ts.isJsxAttribute).filter((node) => node.name.getText() === "value"))?.initializer, "{access}")) return undefined;
  if (!references(access.name, (node) => node === access.name || (ts.isJsxExpression(node.parent) && node.parent.parent.parent === provider.attributes)
    || (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken)
    || (readOnlyProperty(node) && node.parent.getText() === "access.isCurrent"))) return undefined;
  const hookAccess = variable(hook, "access"), mutate = variable(hook, "mutate");
  if (!hookAccess || !matches(hookAccess.initializer, "useContext(MortgageContext)") || !mutate?.initializer
    || !matches(mutate.initializer, `useCallback(async (endpoint: string, method: string, body: unknown) => {
      const response = await access.request(\`\${endpoint}?workspaceId=\${encodeURIComponent(access.workspaceId)}\`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      await readResult(access, response);
      if (!access.isCurrent()) throw ended();
      refresh();
    }, [access, refresh])`)) return undefined;
  if (!references(context.name, (node) => node === context.name
    || (ts.isCallExpression(node.parent) && node.parent === hookAccess.initializer)
    || ((ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
      && (node.parent.parent === provider || (ts.isJsxClosingElement(node.parent.parent) && node.parent.parent.parent === provider.parent))))) return undefined;
  const resultReader = declaration("readResult");
  const readerAccess = resultReader?.parameters[0]?.name;
  if (!readerAccess || !references(readerAccess, (node) => node === readerAccess
    || (readOnlyProperty(node) && node.parent.getText() === "access.isCurrent"))) return undefined;
  const hookReturn = one(returnsFrom(hook));
  if (!hookReturn?.expression || !ts.isObjectLiteralExpression(hookReturn.expression)
    || hookReturn.expression.properties.some(ts.isSpreadAssignment)) return undefined;
  const requestProperty = one(hookReturn.expression.properties.filter((node) => node.name?.getText() === "request"));
  if (!requestProperty || !ts.isPropertyAssignment(requestProperty) || !matches(requestProperty.initializer, "access.request")) return undefined;
  const requestCalls = nodes(hook).filter(ts.isCallExpression).filter((node) => ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "request" && boundTo(node.expression.expression, hookAccess.name));
  if (requestCalls.length !== 3 || !references(hookAccess.name, (node) => node === hookAccess.name || dependency(node)
    || (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken)
    || (readOnlyProperty(node) && ["access.workspaceId", "access.isCurrent", "access.request"].includes(node.parent.getText())
      && (node.parent.getText() !== "access.request" || node.parent === requestProperty.initializer || requestCalls.some((call) => call.expression === node.parent)))
    || (ts.isCallExpression(node.parent) && node.parent.expression.getText() === "readResult" && node.parent.arguments[0] === node))) return undefined;
  const calls = new Map<string, Set<number>>();
  const approve = (file: string, node: ts.CallExpression) => {
    const expression = node.expression;
    const receiver = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    if (!calls.has(file)) calls.set(file, new Set());
    calls.get(file)!.add(receiver.getStart());
  };
  requestCalls.forEach((node) => approve(mortgageFile, node));
  if (!references(mutate.name, (node) => node === mutate.name || dependency(node)
    || (ts.isCallExpression(node.parent) && node.parent.expression === node))) return undefined;
  nodes(hook).filter(ts.isCallExpression).filter((node) => boundTo(node.expression, mutate.name)).forEach((node) => approve(mortgageFile, node));
  const analytics = files.get(mortgageAnalyticsFile);
  if (analytics) {
    const hookImport = imported(analytics, "useMortgageWorkspace", "@/lib/mortgage-workspace");
    const report = one(analytics.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name?.text === "MortgageAnalyticsReport"));
    const workspace = report && variable(report, "workspace");
    if (!hookImport || !report || !workspace?.initializer || !ts.isCallExpression(workspace.initializer)
      || !boundTo(workspace.initializer.expression, hookImport.name)
      || !references(hookImport.name, (node) => node === hookImport.name
        || (ts.isCallExpression(node.parent) && node.parent === workspace.initializer && node.parent.expression === node))) return undefined;
    const binding = one(nodes(report).filter(ts.isVariableDeclaration).filter((node) => ts.isObjectBindingPattern(node.name)
      && node.name.elements.some((element) => element.name.getText() === "request")));
    if (!binding || !constant(binding) || !ts.isObjectBindingPattern(binding.name) || !binding.initializer
      || !boundTo(binding.initializer, workspace.name) || !matches(binding.name, "{ isCurrent, request }")) return undefined;
    const request = binding.name.elements.find((node) => node.name.getText() === "request")!;
    const requestCall = one(nodes(report).filter(ts.isCallExpression).filter((node) => boundTo(node.expression, request.name)));
    if (!requestCall || !references(request.name, (node) => node === request.name || node === requestCall.expression || dependency(node))
      || !references(workspace.name, (node) => node === workspace.name || node === binding.initializer
        || (readOnlyProperty(node) && node.parent.getText() !== "workspace.request"))) return undefined;
    approve(mortgageAnalyticsFile, requestCall);
  }
  return calls;
}

export function crmTransportOffenders(sources: CrmSources): string[] {
  const injectedDeletionIsSafe = hasVerifiedDeletionTransport(sources);
  const injectedAdminIsSafe = hasVerifiedAdminTransport(sources);
  const mortgageReceivers = verifiedMortgageReceivers(sources);
  const sharedHelpers = new Set(["crmFetch", "crmRequest", "crmJson"]);
  const offenders: string[] = [];
  for (const [name, source] of sources) {
    if (name === "lib/api.ts") continue;
    const receivers = new Set<string>();
    for (const match of source.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?\s*\(\s*[`"'][^`"']*\/api\/crm\//g)) {
      if (!mortgageReceivers?.get(name)?.has(match.index!)) receivers.add(match[1]);
    }
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
    if (name === 'pages/AdminCenter.tsx' && injectedAdminIsSafe) safe.add('crmFetch');
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
      else if (name === mortgageFile || name === mortgageAnalyticsFile) offenders.push(name + ": CRM path uses an unverified scoped receiver " + helper);
      else if (!safe.has(helper)) offenders.push(name + ": CRM paths flow through " + helper + ", which never reaches crmFetch");
    }
    if (name === modelFile && !injectedDeletionIsSafe) offenders.push(name + ": unverified injected transport chain");
    if ((name === mortgageFile || name === mortgageAnalyticsFile) && !mortgageReceivers) offenders.push(name + ": unverified scoped mortgage transport chain");
  }
  return offenders;
}
