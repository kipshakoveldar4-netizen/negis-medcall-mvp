import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

// Reviewed source receipts, not a general dataflow proof. Any change requires
// re-review of the complete lifetime/consumer chain and its runtime tests.
const deletionSources = new Map([
  ["pages/LeadsPage.tsx", "78a76e3b68ee5c60a3e27df73304f6b88467fa7256acfa1db8748215d6f13b2a"],
  ["lib/siteInquiryDeletion.ts", "bfbec0bf29e4ced30d017b3a5606c275373db8704af25c9f8dd5f330200a164e"],
  ["components/crm/site-inquiry-deletion.tsx", "39260a8d9fab73e336c8361d645288a559b68a9ad4c1dfa5b207c2d93fc415f3"],
  ["components/crm/site-deletion-recovery.tsx", "2e1d738cf8cc4869e23adcdb39a3b7f74d5cdbb8cd0a05a252c43442064d80d1"],
]);
const controlSources = new Map([
  ["pages/AiControlCenter.tsx", "3f34b2514f0039d9db8ab141965e0efe5a7b0b70fe07c3f8b360e2eabdcba498"],
]);
const deletionEdges = new Map([
  ["lib/siteInquiryDeletion", { caller: "components/crm/site-inquiry-deletion.tsx", name: "createSiteInquiryDeletion" }],
  ["components/crm/site-inquiry-deletion", { caller: "pages/LeadsPage.tsx", name: "SiteInquiryDeletion" }],
  ["components/crm/site-deletion-recovery", { caller: "pages/LeadsPage.tsx", name: "SiteDeletionRecovery" }],
]);

function modulePath(file: string, specifier: string): string {
  return (specifier.startsWith("@/") ? specifier.slice(2)
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))).replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function closedDeletionEdges(sources: ReadonlyMap<string, string>): boolean {
  const counts = new Map<string, number>();
  let valid = true;
  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const target = modulePath(file, node.text);
        const edge = deletionEdges.get(target);
        if (edge) {
          const parent = node.parent;
          if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) {
            const clause = parent.importClause;
            const bindings = clause?.namedBindings;
            const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
              && bindings.elements.length > 0 && bindings.elements.every(entry => entry.isTypeOnly));
            if (!typeOnly) {
              const runtime = bindings && ts.isNamedImports(bindings)
                ? bindings.elements.filter(entry => !entry.isTypeOnly) : [];
              if (file !== edge.caller || clause?.name || runtime.length !== 1
                || runtime[0].name.text !== edge.name || runtime[0].propertyName) valid = false;
              counts.set(target, (counts.get(target) ?? 0) + 1);
            }
          } else if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node && parent.isTypeOnly) {
            // A type-only edge cannot create another runtime consumer.
          } else valid = false;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return valid && [...deletionEdges.keys()].every(target => counts.get(target) === 1);
}

export function reviewedScopedTransports(sources: ReadonlyMap<string, string>) {
  const calls = new Map<string, Set<number>>();
  const failures = new Set<string>();
  const inspect = (receipts: ReadonlyMap<string, string>, closed: () => boolean,
    admitted: ReadonlyMap<string, ReadonlyMap<string, number>>): void => {
    if (![...receipts.keys()].some(file => sources.has(file))) return;
    const matches = [...receipts].every(([file, digest]) => {
      const source = sources.get(file);
      return source !== undefined
        && createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex") === digest;
    });
    if (!matches || !closed()) {
      for (const file of receipts.keys()) if (sources.has(file)) failures.add(file);
      return;
    }
    for (const [file, expected] of admitted) {
      const ast = ts.createSourceFile(file, sources.get(file)!, ts.ScriptTarget.Latest, true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const positions = new Set<number>(), counts = new Map<string, number>();
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const receiver = ts.isIdentifier(node.expression) ? node.expression
            : ts.isPropertyAccessExpression(node.expression) ? node.expression.name : undefined;
          const arg = node.arguments[0];
          if (receiver && expected.has(receiver.text) && arg
            && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))
            && arg.getText(ast).includes("/api/crm/")) {
            counts.set(receiver.text, (counts.get(receiver.text) ?? 0) + 1);
            positions.add(receiver.getStart(ast));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      if ([...expected].every(([name, count]) => counts.get(name) === count)) calls.set(file, positions);
      else failures.add(file);
    }
  };
  inspect(deletionSources, () => closedDeletionEdges(sources), new Map([
    ["lib/siteInquiryDeletion.ts", new Map([["request", 2]])],
  ]));
  inspect(controlSources, () => true, new Map([
    ["pages/AiControlCenter.tsx", new Map([["request", 1], ["remoteRead", 3]])],
  ]));
  return { calls, failures };
}
