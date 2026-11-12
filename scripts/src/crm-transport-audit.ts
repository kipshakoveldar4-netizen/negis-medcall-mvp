import path from "node:path";
import ts from "typescript";
import { reviewedScopedTransports } from "./reviewed-scoped-transports";

export type CrmSources = ReadonlyMap<string, string>;

function modulePath(file: string, specifier: string): string {
  return (specifier.startsWith("@/") ? specifier.slice(2)
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))).replace(/\.tsx?$/, "");
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
const activityDialogFile = "components/mortgage/ActivityDialog.tsx";
const contactFormFile = "components/mortgage/MortgageContactForm.tsx";
const contractPanelFile = "components/mortgage/MortgageContractPanel.tsx";
const resultsFile = "components/mortgage/MortgageResults.tsx";
const mortgageConsumerFiles = new Set([mortgageFile, mortgageAnalyticsFile, activityDialogFile, contactFormFile, contractPanelFile, resultsFile]);

// Prove this context -> hook -> consumer chain, not the names `request` or
// `mutate`. Only the exact call sites below receive an exemption.
function verifiedMortgageReceivers(sources: CrmSources): Map<string, Set<number>> | undefined {
  const files = new Map([...sources]
    .map(([file, source]) => [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]));
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
  const nodeCache = new Map<ts.Node, ts.Node[]>();
  const nodes = (root: ts.Node): ts.Node[] => {
    const cached = nodeCache.get(root);
    if (cached) return cached;
    const result: ts.Node[] = [];
    const visit = (node: ts.Node) => { result.push(node); ts.forEachChild(node, visit); };
    visit(root);
    nodeCache.set(root, result);
    return result;
  };
  const one = <T,>(values: T[]): T | undefined => values.length === 1 ? values[0] : undefined;
  const symbol = (node: ts.Node) => ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent) : checker.getSymbolAtLocation(node);
  const boundTo = (node: ts.Node, name: ts.Node) => Boolean(symbol(name)) && symbol(node) === symbol(name);
  const references = (name: ts.Node, allowed: (node: ts.Identifier) => boolean) => [...files.values()]
    .every((ast) => nodes(ast).filter(ts.isIdentifier).filter((node) => node.text === name.getText() && boundTo(node, name)).every(allowed));
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
  const readOnlyProperty = (node: ts.Node) => {
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
  for (const name of ["createContext", "useContext", "useMemo", "useCallback", "useRef", "useEffect"]) {
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
  const snapshotEffect = one(nodes(hook).filter(ts.isCallExpression).filter((node) => node.expression.getText() === "useEffect"));
  const callback = (name: string) => {
    const initializer = variable(hook, name)?.initializer;
    return initializer && ts.isCallExpression(initializer) && initializer.expression.getText() === "useCallback"
      ? initializer.arguments[0] : undefined;
  };
  // Pin each awaited response to its owning closure and the context binding;
  // an extra authenticated call must not compensate for a replaced transport.
  const requestCalls: ts.CallExpression[] = [];
  for (const [owner, expected] of [
    [snapshotEffect?.arguments[0], "access.request(path, { signal: controller.signal })"],
    [callback("mutate"), `access.request(\`\${endpoint}?workspaceId=\${encodeURIComponent(access.workspaceId)}\`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })`],
    [callback("searchContacts"), "access.request(`/api/crm/mortgage-workspace?${search}`)"],
    [callback("updateContact"), "access.request(`/api/crm/lead-stages?workspaceId=${encodeURIComponent(access.workspaceId)}`)"],
  ] as const) {
    if (!owner || !ts.isArrowFunction(owner)) return undefined;
    const response = variable(owner, "response")?.initializer;
    if (!response || !ts.isAwaitExpression(response) || !ts.isCallExpression(response.expression)) return undefined;
    const call = response.expression;
    if (!matches(call, expected) || !ts.isPropertyAccessExpression(call.expression)
      || !boundTo(call.expression.expression, hookAccess.name)) return undefined;
    requestCalls.push(call);
  }
  const allRequestCalls = nodes(hook).filter(ts.isCallExpression).filter((node) => ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "request" && boundTo(node.expression.expression, hookAccess.name));
  if (allRequestCalls.length !== requestCalls.length || !allRequestCalls.every((node) => requestCalls.includes(node))
    || !references(hookAccess.name, (node) => node === hookAccess.name || dependency(node)
    || (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken)
    || (readOnlyProperty(node) && ["access.workspaceId", "access.isCurrent", "access.request"].includes(node.parent.getText())
      && (node.parent.getText() !== "access.request" || node.parent === requestProperty.initializer || requestCalls.some((call) => call.expression === node.parent)))
    || (ts.isCallExpression(node.parent) && node.parent.expression.getText() === "readResult" && node.parent.arguments[0] === node))) return undefined;
  const calls = new Map<string, Set<number>>();
  // Shared parents are checked after every boundary has proved its exact forward.
  const parentForwards = new Set<ts.Node>();
  const parentChecks: (() => boolean)[] = [];
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
    if (!requestCall || !references(request.name, (node) => node === request.name || node === requestCall.expression || dependency(node))) return undefined;
    parentChecks.push(() => references(workspace.name, (node) => node === workspace.name || node === binding.initializer
      || (readOnlyProperty(node) && (node.parent.getText() !== "workspace.request" || parentForwards.has(node.parent)))));
    approve(mortgageAnalyticsFile, requestCall);
  }

  const functionIn = (ast: ts.SourceFile, name: string) => one(ast.statements.filter(ts.isFunctionDeclaration)
    .filter((node) => node.name?.text === name));
  const ownerOf = (node: ts.Node): ts.Node | undefined => {
    let parent = node.parent;
    while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
    return parent;
  };
  const jsxValue = (mount: ts.JsxSelfClosingElement, name: string) => {
    const attribute = one(mount.attributes.properties.filter(ts.isJsxAttribute).filter((node) => node.name.getText() === name));
    return attribute?.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
  };
  const workspaceUse = (node: ts.Node, requests: ts.Node[], forwards: ts.Node[] = []) => {
    if (forwards.includes(node)) return true;
    const parent = node.parent;
    return readOnlyProperty(node) && ts.isPropertyAccessExpression(parent) && parent.expression === node
      && (parent.name.text !== "request" || requests.includes(parent) || dependency(parent));
  };
  // Every import and mount of these injection boundaries must be accounted for,
  // including callers outside the usual mortgage directory.
  const verifyParents = (file: string, name: string, parents: [string, string][], prop: "workspace" | "request") => {
    const ast = files.get(file), component = ast && functionIn(ast, name);
    if (!component?.name || !component.body || !references(component.name, (node) => node === component.name
      || (name === "ActivityDialog" && ts.isExportAssignment(node.parent) && !node.parent.isExportEquals))) return false;
    const mounts: ts.JsxSelfClosingElement[] = [];
    for (const [caller, owner] of parents) {
      const parentAst = files.get(caller), fn = parentAst && functionIn(parentAst, owner);
      const binding = parentAst && imported(parentAst, name, `@/${file.replace(/\.tsx$/, "")}`);
      const hookBinding = parentAst && imported(parentAst, "useMortgageWorkspace", "@/lib/mortgage-workspace");
      const workspace = fn && variable(fn, "workspace");
      const hookCall = workspace?.initializer;
      if (!parentAst || !fn || !binding || !hookBinding || !workspace?.initializer
        || !hookCall || !ts.isCallExpression(hookCall) || !boundTo(hookCall.expression, hookBinding.name)
        || !references(hookBinding.name, (node) => node === hookBinding.name || node === hookCall.expression)) return false;
      const mount = one(nodes(fn).filter(ts.isJsxSelfClosingElement).filter((node) => boundTo(node.tagName, binding.name)));
      if (!mount || ownerOf(mount) !== fn || mount.attributes.properties.some(ts.isJsxSpreadAttribute)
        || !references(binding.name, (node) => node === binding.name || node === mount.tagName)) return false;
      const value = jsxValue(mount, prop);
      const receiver = value && prop === "request" && ts.isPropertyAccessExpression(value) && value.name.text === "request"
        ? value.expression : value;
      if (!value || (prop === "request" && receiver === value) || !receiver || !boundTo(receiver, workspace.name)) return false;
      parentForwards.add(value);
      parentChecks.push(() => references(workspace.name, (node) => node === workspace.name || dependency(node)
        || workspaceUse(node, [...parentForwards], [...parentForwards])
        || (caller === mortgageAnalyticsFile && ts.isVariableDeclaration(node.parent)
          && node.parent.initializer === node && matches(node.parent.name, "{ isCurrent, request }"))));
      mounts.push(mount);
    }
    for (const [caller, source] of files) {
      for (const node of nodes(source)) {
        if (ts.isStringLiteral(node) && modulePath(caller, node.text) === file.replace(/\.tsx$/, "")) {
          const declaration = node.parent;
          if (!parents.some(([expected]) => expected === caller) || !ts.isImportDeclaration(declaration)
            || declaration.importClause?.isTypeOnly || declaration.importClause?.name
            || !declaration.importClause?.namedBindings || !ts.isNamedImports(declaration.importClause.namedBindings)
            || declaration.importClause.namedBindings.elements.some((entry) => entry.name.text !== name || entry.propertyName || entry.isTypeOnly)) return false;
        }
        if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === name
          && !mounts.includes(node as ts.JsxSelfClosingElement)) return false;
      }
    }
    return true;
  };
  const activity = files.get(activityDialogFile);
  if (activity) {
    if (!verifyParents(activityDialogFile, "ActivityDialog", [
      ["pages/MortgageCalendar.tsx", "MortgageCalendarBody"], ["pages/MortgageTasks.tsx", "MortgageTasksBody"],
    ], "workspace")) return undefined;
    const dialog = functionIn(activity, "ActivityDialog")!, form = functionIn(activity, "ActivityForm");
    const props = dialog.parameters[0];
    const parameter = form?.parameters[0];
    if (dialog.parameters.length !== 1 || !props || !ts.isIdentifier(props.name) || props.initializer
      || !form?.name || !parameter || form.parameters.length !== 1 || parameter.initializer || !ts.isObjectBindingPattern(parameter.name)) return undefined;
    const workspace = one(parameter.name.elements.filter((node) => node.name.getText() === "workspace"));
    const mount = one(nodes(dialog).filter(ts.isJsxSelfClosingElement).filter((node) => boundTo(node.tagName, form.name!)));
    if (!workspace || workspace.propertyName || workspace.initializer || workspace.dotDotDotToken || !mount
      || !references(form.name, (node) => node === form.name || node === mount.tagName)) return undefined;
    const spread = one(mount.attributes.properties.filter(ts.isJsxSpreadAttribute));
    if (!spread || !boundTo(spread.expression, props.name) || mount.attributes.properties.length !== 3
      || mount.attributes.properties.filter(ts.isJsxAttribute).some((node) => !["key", "timeZone"].includes(node.name.getText()))
      || !jsxValue(mount, "key") || !jsxValue(mount, "timeZone")
      || !references(props.name, (node) => node === props.name || node === spread.expression
        || (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
          && (node.parent.name.text === "workspace" ? workspaceUse(node.parent, []) : readOnlyProperty(node))))) return undefined;
    const requests = nodes(form).filter(ts.isCallExpression).filter((node) => ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "request" && node.expression.expression.getText() === "workspace");
    if (requests.length !== 1 || !ts.isPropertyAccessExpression(requests[0].expression)
      || !boundTo(requests[0].expression.expression, workspace.name)
      || !references(workspace.name, (node) => node === workspace.name || workspaceUse(node, requests.map((call) => call.expression)))) return undefined;
    approve(activityDialogFile, requests[0]);
  }
  const contact = files.get(contactFormFile);
  if (contact) {
    if (!verifyParents(contactFormFile, "MortgageContactForm", [
      ["pages/MortgageClients.tsx", "MortgageClientsBody"], ["components/mortgage/MortgageContactDetail.tsx", "MortgageContactDetail"],
    ], "request")) return undefined;
    const form = functionIn(contact, "MortgageContactForm")!, parameter = form.parameters[0];
    if (form.parameters.length !== 1 || !parameter || parameter.initializer || !ts.isObjectBindingPattern(parameter.name)) return undefined;
    const request = one(parameter.name.elements.filter((node) => node.name.getText() === "request"));
    if (!request || request.propertyName || request.initializer || request.dotDotDotToken) return undefined;
    const requests = nodes(form).filter(ts.isCallExpression).filter((node) => ts.isIdentifier(node.expression) && node.expression.text === "request");
    if (requests.length !== 1 || !boundTo(requests[0].expression, request.name)
      || !references(request.name, (node) => node === request.name || node === requests[0].expression || dependency(node))) return undefined;
    approve(contactFormFile, requests[0]);
  }
  const requestParameter = (fn: ts.FunctionDeclaration) => {
    const parameter = fn.parameters[0];
    if (fn.parameters.length !== 1 || !parameter || parameter.initializer || !ts.isObjectBindingPattern(parameter.name)) return undefined;
    const request = one(parameter.name.elements.filter((node) => node.name.getText() === "request"));
    return request && !request.propertyName && !request.initializer && !request.dotDotDotToken ? request : undefined;
  };
  const verifiedReactHook = (ast: ts.SourceFile, name: string) => {
    const binding = imported(ast, name, "react");
    return binding && references(binding.name, (node) => node === binding.name
      || (ts.isCallExpression(node.parent) && node.parent.expression === node))
      && nodes(ast).filter(ts.isCallExpression).filter((node) => ts.isIdentifier(node.expression) && node.expression.text === name)
        .every((node) => boundTo(node.expression, binding.name));
  };
  const panel = files.get(contractPanelFile);
  if (panel) {
    if (!verifyParents(contractPanelFile, "MortgageContractPanel", [
      ["components/mortgage/MortgageContactDetail.tsx", "MortgageContactDetail"],
    ], "request")) return undefined;
    const wrapper = functionIn(panel, "MortgageContractPanel")!, session = functionIn(panel, "MortgageContractSession");
    const props = wrapper.parameters[0], request = session && requestParameter(session);
    const mount = session?.name && one(nodes(wrapper).filter(ts.isJsxSelfClosingElement).filter((node) => boundTo(node.tagName, session.name!)));
    if (wrapper.parameters.length !== 1 || !props || !ts.isIdentifier(props.name) || props.initializer
      || !session?.name || session.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword) || !request || !mount
      || !references(session.name, (node) => node === session.name || node === mount.tagName)) return undefined;
    const spread = one(mount.attributes.properties.filter(ts.isJsxSpreadAttribute));
    if (!spread || !boundTo(spread.expression, props.name) || mount.attributes.properties.length !== 2
      || !jsxValue(mount, "key") || mount.attributes.properties.filter(ts.isJsxAttribute).some((node) => node.name.getText() !== "key")
      || !references(props.name, (node) => node === props.name || node === spread.expression
        || (readOnlyProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
          && ["workspaceId", "leadId", "timeZone"].includes(node.parent.name.text)))) return undefined;
    const requests = nodes(session).filter(ts.isCallExpression).filter((node) => ts.isIdentifier(node.expression) && node.expression.text === "request");
    const load = variable(session, "load");
    if (requests.length !== 2 || !requests.every((node) => boundTo(node.expression, request.name))
      || !load?.initializer || !verifiedReactHook(panel, "useCallback") || !ts.isCallExpression(load.initializer)
      || load.initializer.expression.getText() !== "useCallback"
      || !references(request.name, (node) => node === request.name || requests.some((call) => call.expression === node)
        || (dependency(node) && node.parent.parent === load.initializer))) return undefined;
    requests.forEach((node) => approve(contractPanelFile, node));
  }
  const results = files.get(resultsFile);
  if (results) {
    if (!verifyParents(resultsFile, "MortgageResults", [[mortgageAnalyticsFile, "MortgageAnalyticsReport"]], "request")) return undefined;
    const component = functionIn(results, "MortgageResults")!, request = requestParameter(component);
    const query = variable(component, "query"), memo = imported(results, "useMemo", "react");
    if (!request || !query || !memo || !["useMemo", "useRef", "useEffect", "useState"].every((name) => verifiedReactHook(results, name)) || !matches(query.initializer,
      "useMemo(() => ({ workspaceId, request, isCurrent, days, refresh }), [workspaceId, request, isCurrent, days, refresh])")
      || !ts.isCallExpression(query.initializer!) || !boundTo(query.initializer.expression, memo.name)
      || !references(memo.name, (node) => node === memo.name || node === (query.initializer as ts.CallExpression).expression)
      || !references(request.name, (node) => node === request.name
        || (ts.isShorthandPropertyAssignment(node.parent) && nodes(query.initializer!).includes(node))
        || (dependency(node) && node.parent.parent === query.initializer))) return undefined;
    const requests = nodes(component).filter(ts.isCallExpression).filter((node) => ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "request");
    const call = one(requests);
    const latest = variable(component, "latest");
    // State retains the query identity, so it must not become a second route
    // for extracting or forwarding the transport captured by that query.
    const stateBinding = one(nodes(component).filter(ts.isVariableDeclaration).filter((node) => constant(node)
      && ts.isArrayBindingPattern(node.name) && node.name.elements.length === 2
      && node.name.elements[0].getText() === "state" && node.name.elements[1].getText() === "setState"));
    const visible = variable(component, "visible");
    const state = stateBinding && ts.isArrayBindingPattern(stateBinding.name) ? stateBinding.name.elements[0] : undefined;
    const setter = stateBinding && ts.isArrayBindingPattern(stateBinding.name) ? stateBinding.name.elements[1] : undefined;
    if (!state || !ts.isBindingElement(state) || !setter || !ts.isBindingElement(setter)
      || !matches(stateBinding?.initializer, 'useState<LoadState>({ query: null, kind: "loading" })')
      || !visible?.initializer || !matches(visible.initializer, 'state.query === query ? state : { kind: "loading" as const }')
      || !references(state.name, (node) => node === state.name || nodes(visible.initializer!).includes(node))
      || !references(setter.name, (node) => node === setter.name || (ts.isCallExpression(node.parent) && node.parent.expression === node))
      || !references(visible.name, (node) => node === visible.name || (readOnlyProperty(node)
        && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        && ["kind", "denied", "message", "data"].includes(node.parent.name.text)))) return undefined;
    if (!call || !ts.isPropertyAccessExpression(call.expression) || !boundTo(call.expression.expression, query.name)
      || !latest || !matches(latest.initializer, "useRef(query)")
      || !references(latest.name, (node) => node === latest.name || (readOnlyProperty(node) && node.parent.getText() === "latest.current"
        && matches(node.parent.parent, "latest.current === query"))
        || (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && matches(node.parent.parent, "latest.current = query")))
      || !references(query.name, (node) => node === query.name
        || (readOnlyProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
          && (node.parent.name.text === "request" ? node.parent === call.expression : ["workspaceId", "days", "isCurrent"].includes(node.parent.name.text)))
        || node.parent === latest.initializer
        || matches(node.parent, "latest.current = query") || matches(node.parent, "latest.current === query") || matches(node.parent, "state.query === query")
        || (dependency(node) && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression.getText() === "useEffect")
        || (ts.isShorthandPropertyAssignment(node.parent) && ts.isObjectLiteralExpression(node.parent.parent)
          && ts.isCallExpression(node.parent.parent.parent) && boundTo(node.parent.parent.parent.expression, setter.name)))) return undefined;
    approve(resultsFile, call);
  }
  if (!parentChecks.every((check) => check())) return undefined;
  return calls;
}

// Prove a closed object-argument injection: the exported helper captures one
// transport, every value use is a direct call, and every caller forwards that
// call's URL through a binding-verified chain to the shared API module.
function verifiedObjectTransports(sources: CrmSources): { calls: Map<string, Set<number>>; failures: Set<string> } {
  const files = new Map<string, ts.SourceFile>();
  const nodes = (root: ts.Node): ts.Node[] => {
    const result: ts.Node[] = [];
    const visit = (node: ts.Node) => { result.push(node); ts.forEachChild(node, visit); };
    visit(root);
    return result;
  };
  const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const owner = (node: ts.Node): ts.Node | undefined => {
    let parent = node.parent;
    while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
    return parent;
  };
  const exported = (fn: ts.FunctionDeclaration) => fn.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword)
    && !fn.modifiers.some((node) => node.kind === ts.SyntaxKind.DefaultKeyword);
  const crmPath = (node: ts.Expression | undefined) => node && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))
    && (ts.isTemplateExpression(node) ? node.head.text : node.text).includes("/api/crm/");
  // Avoid building another binding graph for source sets without this shape.
  const roots: ts.FunctionDeclaration[] = [];
  for (const [file, source] of sources) {
    if (!source.includes("/api/crm/") || !/export\s+(?:async\s+)?function\b/.test(source)) continue;
    const ast = parse(file, source);
    files.set(file, ast);
    for (const fn of ast.statements.filter(ts.isFunctionDeclaration)) {
      if (exported(fn) && fn.body && fn.name && fn.parameters.length === 1 && ts.isIdentifier(fn.parameters[0].name)
        && nodes(fn.body).some((node) => ts.isCallExpression(node) && crmPath(node.arguments[0])
          && ts.isIdentifier(node.expression) && owner(node) === fn)
        && nodes(fn.body).some((node) => ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name))) roots.push(fn);
    }
  }
  const calls = new Map<string, Set<number>>(), failures = new Set<string>();
  if (!roots.length) return { calls, failures };
  for (const [file, source] of sources) if (!files.has(file)) files.set(file, parse(file, source));
  const program = ts.createProgram([...files.keys()], { noLib: true, noResolve: true }, {
    getSourceFile: (file) => files.get(file), getDefaultLibFileName: () => "", writeFile: () => {},
    getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (file) => files.has(file),
    readFile: (file) => sources.get(file), getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  });
  const checker = program.getTypeChecker();
  const cache = new Map<ts.Node, ts.Node[]>();
  const all = (node: ts.Node) => {
    if (!cache.has(node)) cache.set(node, nodes(node));
    return cache.get(node)!;
  };
  const symbol = (node: ts.Node) => ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
  const bound = (node: ts.Node, name: ts.Node) => Boolean(symbol(name)) && symbol(node) === symbol(name);
  const references = (name: ts.Node) => all(name.getSourceFile()).filter(ts.isIdentifier).filter((node) => bound(node, name));
  const typeUse = (node: ts.Node): boolean => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent)) return true;
      if (ts.isStatement(parent) || ts.isExpression(parent)) return false;
    }
    return false;
  };
  const constant = (node: ts.VariableDeclaration) => ts.isVariableDeclarationList(node.parent)
    && Boolean(node.parent.flags & ts.NodeFlags.Const);
  const one = <T,>(values: T[]): T | undefined => values.length === 1 ? values[0] : undefined;
  const directUse = (node: ts.Node) => ts.isCallExpression(node.parent) && node.parent.expression === node;
  const apiImport = (name: ts.Identifier) => {
    const declarations = symbol(name)?.declarations;
    const entry = declarations?.length === 1 ? declarations[0] : undefined;
    if (!entry || !ts.isImportSpecifier(entry) || entry.isTypeOnly) return false;
    const declaration = entry.parent.parent.parent;
    return ts.isImportDeclaration(declaration) && !declaration.importClause?.isTypeOnly && ts.isStringLiteral(declaration.moduleSpecifier)
      && modulePath(name.getSourceFile().fileName, declaration.moduleSpecifier.text) === "lib/api"
      && ["crmFetch", "crmRequest", "crmJson"].includes((entry.propertyName ?? entry.name).text)
      && references(entry.name).every((node) => node === entry.name || typeUse(node) || directUse(node));
  };
  type Forwarder = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  const forwarding = new Set<ts.Node>();
  const forwards = (fn: Forwarder, index: number): boolean => {
    if (forwarding.has(fn) || !fn.body) return false;
    const parameter = fn.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return false;
    forwarding.add(fn);
    const finish = (valid: boolean) => { forwarding.delete(fn); return valid; };
    const uses = references(parameter.name).filter((node) => node !== parameter.name && !typeUse(node));
    const url = one(uses);
    if (!url || !ts.isCallExpression(url.parent) || !ts.isIdentifier(url.parent.expression)
      || owner(url.parent) !== fn || url.parent.questionDotToken) return finish(false);
    const call = url.parent, target = call.expression as ts.Identifier;
    const argument = call.arguments.indexOf(url);
    if (argument < 0) return finish(false);
    // A neighboring/dead authenticated call cannot prove the URL's real path.
    let statement: ts.Node = call;
    if (ts.isAwaitExpression(statement.parent)) statement = statement.parent;
    if (ts.isVariableDeclaration(statement.parent) && statement.parent.initializer === statement) {
      const declaration = statement.parent;
      if (!constant(declaration) || !ts.isVariableDeclarationList(declaration.parent) || declaration.parent.declarations.length !== 1) return finish(false);
      statement = declaration.parent.parent;
    } else if (ts.isReturnStatement(statement.parent) || ts.isExpressionStatement(statement.parent)) statement = statement.parent;
    else if (fn.body !== statement) return finish(false);
    if (statement !== fn.body && statement.parent !== fn.body) return finish(false);
    if (all(fn.body).some((node) => ts.isReturnStatement(node) && owner(node) === fn && node.getStart() < statement.getStart())) return finish(false);
    if (all(fn.body).some((node) => ts.isCallExpression(node)
      && ((ts.isIdentifier(node.expression) && node.expression.text === "fetch")
        || (ts.isPropertyAccessExpression(node.expression) && ["fetch", "sendBeacon"].includes(node.expression.name.text))))) return finish(false);
    if (apiImport(target)) return finish(argument === 0);
    const declarations = symbol(target)?.declarations;
    const declaration = declarations?.length === 1 ? declarations[0] : undefined;
    const local = declaration && ts.isFunctionDeclaration(declaration) ? declaration
      : declaration && ts.isVariableDeclaration(declaration) && constant(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
    const name = declaration && (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) ? declaration.name : undefined;
    return finish(Boolean(local && name && references(name).every((node) => node === name || typeUse(node) || directUse(node))
      && forwards(local, argument)));
  };
  for (const fn of roots) {
    const file = fn.getSourceFile().fileName;
    const paths = all(fn.body!).filter(ts.isCallExpression).filter((node) => crmPath(node.arguments[0]) && owner(node) === fn);
    const receiver = paths[0].expression;
    const declaration = symbol(receiver)?.declarations?.[0];
    // Positional injections and scoped hooks retain their existing proofs.
    if (!ts.isIdentifier(receiver) || !declaration || !ts.isBindingElement(declaration)
      || !ts.isObjectBindingPattern(declaration.parent) || !ts.isVariableDeclaration(declaration.parent.parent)) continue;
    let valid = !fn.parameters[0].initializer && !fn.parameters[0].dotDotDotToken
      && !declaration.initializer && !declaration.dotDotDotToken && ts.isIdentifier(declaration.name)
      && (!declaration.propertyName || ts.isIdentifier(declaration.propertyName));
    const binding = declaration.parent.parent;
    const transport = (declaration.propertyName ?? declaration.name).getText();
    valid &&= constant(binding) && declaration.parent.elements.filter((node) => (node.propertyName ?? node.name).getText() === transport).length === 1
      && paths.every((call) => bound(call.expression, declaration.name))
      && references(declaration.name).every((node) => node === declaration.name || directUse(node));
    let input = binding.initializer;
    // Follow only immutable identity aliases/snapshots, before the capture.
    const seen = new Set<ts.Node>();
    let capture: ts.Node = binding;
    while (valid && input && ts.isIdentifier(input) && !bound(input, fn.parameters[0].name)) {
      const alias = symbol(input)?.declarations?.[0];
      if (!alias || !ts.isVariableDeclaration(alias) || !constant(alias) || seen.has(alias)
        || !alias.initializer || alias.getStart() >= capture.getStart()
        || !references(alias.name).every((node) => node === alias.name || node.getStart() > binding.getStart() || node === input)) { valid = false; break; }
      seen.add(alias);
      capture = alias;
      input = alias.initializer;
      if (ts.isObjectLiteralExpression(input) && input.properties.length === 1 && ts.isSpreadAssignment(input.properties[0])) input = input.properties[0].expression;
    }
    valid &&= Boolean(input && ts.isIdentifier(input) && bound(input, fn.parameters[0].name)
      && references(fn.parameters[0].name).every((node) => node === fn.parameters[0].name || node === input || node.getStart() > binding.getStart()));
    const helperCalls: ts.CallExpression[] = [];
    const helperBindings = new Set([symbol(fn.name!)]);
    const use = (node: ts.Identifier) => {
      if (typeUse(node)) return true;
      if (!directUse(node)) return false;
      helperCalls.push(node.parent as ts.CallExpression);
      return true;
    };
    valid &&= references(fn.name!).every((node) => node === fn.name || use(node));
    const module = file.replace(/\.tsx?$/, "");
    for (const ast of files.values()) {
      for (const literal of all(ast).filter(ts.isStringLiteral)) {
        if (modulePath(ast.fileName, literal.text) !== module) continue;
        const parent = literal.parent;
        if (!ts.isImportDeclaration(parent)) { valid = false; continue; }
        if (parent.importClause?.isTypeOnly) continue;
        const clause = parent.importClause, imports = clause?.namedBindings;
        if (!clause || clause.name || !imports || !ts.isNamedImports(imports)) { valid = false; continue; }
        for (const entry of imports.elements) {
          if (!entry.isTypeOnly && (entry.propertyName ?? entry.name).text === fn.name!.text) {
            helperBindings.add(symbol(entry.name));
            valid &&= references(entry.name).every((node) => node === entry.name || use(node));
          }
        }
      }
    }
    // A same-named fake import or shadow cannot stand in for a real caller.
    valid &&= [...files.values()].every((ast) => all(ast).filter(ts.isIdentifier)
      .filter((node) => node.text === fn.name!.text && directUse(node)).every((node) => helperBindings.has(symbol(node))));
    valid &&= helperCalls.length > 0 && helperCalls.every((call) => {
      const object = call.arguments[0];
      if (call.arguments.length !== 1 || call.questionDotToken || !object || !ts.isObjectLiteralExpression(object)
        || object.properties.some((node) => ts.isSpreadAssignment(node) || (node.name && ts.isComputedPropertyName(node.name)))) return false;
      const property = one(object.properties.filter((node) => node.name && (ts.isStringLiteral(node.name) ? node.name.text : node.name.getText()) === transport));
      if (!property || !ts.isPropertyAssignment(property)) return false;
      const callback = property.initializer;
      return (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && forwards(callback, 0);
    });
    if (!valid) failures.add(file);
    else {
      if (!calls.has(file)) calls.set(file, new Set());
      for (const node of paths) calls.get(file)!.add(node.getStart());
    }
  }
  return { calls, failures };
}

export function crmTransportOffenders(sources: CrmSources): string[] {
  const reviewedTransports = reviewedScopedTransports(sources);
  const injectedAdminIsSafe = hasVerifiedAdminTransport(sources);
  const mortgageReceivers = verifiedMortgageReceivers(sources);
  const objectTransports = verifiedObjectTransports(sources);
  const sharedHelpers = new Set(["crmFetch", "crmRequest", "crmJson"]);
  const offenders: string[] = [];
  for (const [name, source] of sources) {
    if (name === "lib/api.ts") continue;
    const receivers = new Set<string>();
    for (const match of source.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?\s*\(\s*[`"'][^`"']*\/api\/crm\//g)) {
      if (!mortgageReceivers?.get(name)?.has(match.index!) && !objectTransports.calls.get(name)?.has(match.index!)
        && !reviewedTransports.calls.get(name)?.has(match.index!)) receivers.add(match[1]);
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
      else if (mortgageConsumerFiles.has(name)) offenders.push(name + ": CRM path uses an unverified scoped receiver " + helper);
      else if (!safe.has(helper)) offenders.push(name + ": CRM paths flow through " + helper + ", which never reaches crmFetch");
    }
    if (reviewedTransports.failures.has(name)) offenders.push(name + ": unreviewed session-bound transport chain");
    if (objectTransports.failures.has(name)) offenders.push(name + ": unverified object-injected transport chain");
    if (mortgageConsumerFiles.has(name) && !mortgageReceivers) offenders.push(name + ": unverified scoped mortgage transport chain");
  }
  return offenders;
}
