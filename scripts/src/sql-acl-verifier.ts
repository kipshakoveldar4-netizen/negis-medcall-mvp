// A deliberately bounded migration verifier, not a general PostgreSQL parser.
// Unsupported ACL syntax must be reviewed, never silently treated as no grant.
import { digest, migrationReview } from "../fixtures/migration-chain-review.mjs";
type Token = { kind: "word" | "quoted" | "string" | "body" | "symbol"; value: string };
export type SqlObject = { schema: string; name: string; args?: string[] };
export type SqlAcl = {
  action: "grant" | "revoke";
  privileges: string[];
  kind: "function" | "table" | "schema" | "sequence";
  objects: SqlObject[];
  roles: string[];
  grantOption: boolean;
  optionOnly: boolean;
  columnScoped: boolean;
};
export type SqlFunction = { object: SqlObject; definer: boolean; emptySearchPath: boolean; references: SqlObject[] };
type SqlTrigger = { name: string; object: SqlObject; fn: SqlObject; timing: string; events: string[]; row: boolean; deferred: boolean };
export type SqlAclAnalysis = {
  acls: SqlAcl[];
  functions: SqlFunction[];
  rls: { object: SqlObject; enabled: boolean }[];
  policies: SqlObject[];
  triggers: SqlTrigger[];
  triggerEdits: { object: SqlObject; name: string }[];
};

function keyword(token: Token | undefined, value: string): boolean {
  return token?.kind === "word" && token.value === value;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (depth && i < source.length) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unterminated SQL comment");
      continue;
    }
    const escaped = /[eE]/.test(source[i]) && source[i + 1] === "'";
    if (source[i] === "'" || source[i] === '"' || escaped) {
      if (escaped) i++;
      const quote = source[i++];
      let value = "";
      let closed = false;
      while (i < source.length) {
        if (source[i] === quote) {
          i++;
          if (source[i] === quote) { value += quote; i++; }
          else { closed = true; break; }
        } else if (escaped && source[i] === "\\") {
          i++;
          if (i >= source.length) throw new Error("Unterminated SQL escape");
          const simple: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          const next = source[i++];
          if (next === "u" || next === "U") {
            const count = next === "u" ? 4 : 8;
            const hex = source.slice(i, i + count);
            if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) throw new Error("Invalid SQL Unicode escape");
            const code = Number.parseInt(hex, 16);
            if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("Invalid SQL Unicode code point");
            value += String.fromCodePoint(code);
            i += count;
          } else if (next === "x") {
            const hex = source.slice(i).match(/^[0-9a-fA-F]{1,2}/)?.[0];
            if (!hex) throw new Error("Invalid SQL hexadecimal escape");
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += hex.length;
          } else if (/[0-7]/.test(next)) {
            const octal = next + (source.slice(i).match(/^[0-7]{0,2}/)?.[0] ?? "");
            value += String.fromCharCode(Number.parseInt(octal, 8));
            i += octal.length - 1;
          } else value += simple[next] ?? next;
        } else value += source[i++];
      }
      if (!closed) throw new Error("Unterminated SQL quote");
      tokens.push({ kind: quote === '"' ? "quoted" : "string", value });
      continue;
    }
    const dollar = source.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0];
    if (dollar) {
      const end = source.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error("Unterminated SQL body");
      tokens.push({ kind: "body", value: source.slice(i + dollar.length, end) });
      i = end + dollar.length;
      continue;
    }
    const word = source.slice(i).match(/^[a-zA-Z_][a-zA-Z_0-9$]*/)?.[0];
    if (word) { tokens.push({ kind: "word", value: word.toLowerCase() }); i += word.length; continue; }
    tokens.push({ kind: "symbol", value: source[i++] });
  }
  return tokens;
}

function split(tokens: Token[], separator: string): Token[][] {
  const parts: Token[][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth++;
    else if (tokens[i].value === ")") depth--;
    if (depth < 0) throw new Error("Unbalanced ACL parentheses");
    if (depth === 0 && tokens[i].value === separator) { parts.push(tokens.slice(start, i)); start = i + 1; }
  }
  if (depth) throw new Error("Unbalanced ACL parentheses");
  parts.push(tokens.slice(start));
  return parts;
}

function identifier(token: Token | undefined): string {
  if (!token || !["word", "quoted"].includes(token.kind)) throw new Error("Unverifiable SQL identifier");
  return token.value;
}

function objectName(tokens: Token[]): SqlObject {
  if (tokens.length === 1) return { schema: "public", name: identifier(tokens[0]) };
  if (tokens.length === 3 && tokens[1].value === ".") {
    return { schema: identifier(tokens[0]), name: identifier(tokens[2]) };
  }
  throw new Error("Unsupported ACL object name");
}

function argumentType(tokens: Token[]): string {
  const end = tokens.findIndex((token) => keyword(token, "default") || token.value === "=");
  if (end >= 0) tokens = tokens.slice(0, end);
  if (keyword(tokens[0], "out")) throw new Error("OUT arguments require explicit ACL review");
  if (["in", "inout", "variadic"].some((mode) => keyword(tokens[0], mode))) tokens = tokens.slice(1);
  const typePrefixes = new Set(["double", "character", "char", "bit", "timestamp", "time", "interval", "national"]);
  if (tokens.length >= 2 && ["word", "quoted"].includes(tokens[1].kind)
    && !typePrefixes.has(tokens[0].value)) tokens = tokens.slice(1);
  if (!tokens.length || tokens.some((token) => !["word", "quoted"].includes(token.kind)
    && ![".", "[", "]"].includes(token.value))) throw new Error("Unsupported ACL argument type");
  const aliases: Record<string, string> = {
    int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean",
    timestamptz: "timestamp with time zone", timestamp: "timestamp without time zone",
  };
  if (tokens.length === 1 && tokens[0].kind === "word") return aliases[tokens[0].value] ?? tokens[0].value;
  return tokens.map((token) => token.kind === "quoted" ? JSON.stringify(token.value) : token.value)
    .join(" ").replace(/\s*([.\[\]])\s*/g, "$1");
}

function functionObject(tokens: Token[]): SqlObject {
  const open = tokens.findIndex((token) => token.value === "(");
  if (open < 0 || tokens.at(-1)?.value !== ")") throw new Error("Function ACL needs an exact signature");
  const args = tokens.slice(open + 1, -1);
  return { ...objectName(tokens.slice(0, open)), args: args.length ? split(args, ",").map(argumentType) : [] };
}

function parseAcl(tokens: Token[]): SqlAcl {
  const action = tokens[0].value as SqlAcl["action"];
  let start = 1;
  const optionOnly = action === "revoke" && keyword(tokens[start], "grant");
  if (optionOnly) {
    if (!keyword(tokens[start + 1], "option") || !keyword(tokens[start + 2], "for")) throw new Error("Unsupported REVOKE option");
    start += 3;
  }
  const on = tokens.findIndex((token, i) => i >= start && keyword(token, "on"));
  if (on < 0) throw new Error("Role membership or unrecognized GRANT requires explicit review");
  let columnScoped = false;
  const privileges = split(tokens.slice(start, on), ",").map((part) => {
    const name = identifier(part[0]);
    if (part.length === 1 || (name === "all" && part.length === 2 && keyword(part[1], "privileges"))) return name;
    if (part[1]?.value === "(" && part.at(-1)?.value === ")") {
      columnScoped = true;
      for (const column of split(part.slice(2, -1), ",")) {
        if (column.length !== 1) throw new Error("Unsupported column ACL");
        identifier(column[0]);
      }
      return name;
    }
    throw new Error("Unsupported SQL privilege");
  });
  const marker = action === "grant" ? "to" : "from";
  let depth = 0;
  let roleStart = -1;
  for (let i = on + 1; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth++;
    else if (tokens[i].value === ")") depth--;
    if (depth === 0 && keyword(tokens[i], marker)) { roleStart = i; break; }
  }
  if (roleStart < 0) throw new Error(`ACL has no unambiguous ${marker.toUpperCase()} roles`);
  let target = tokens.slice(on + 1, roleStart);
  let kind: SqlAcl["kind"] = "table";
  let explicitKind = false;
  if (["function", "procedure", "routine", "table", "sequence", "schema"].some((value) => keyword(target[0], value))) {
    explicitKind = true;
    const label = target[0].value;
    kind = ["procedure", "routine"].includes(label) ? "function" : label as SqlAcl["kind"];
    target = target.slice(1);
  }
  let objects: SqlObject[];
  if (!explicitKind && target.length === 1 && ["functions", "routines", "procedures", "tables", "sequences"].some((value) => keyword(target[0], value))) {
    kind = target[0].value === "tables" ? "table" : target[0].value === "sequences" ? "sequence" : "function";
    objects = [{ schema: "public", name: "*" }];
  } else if (keyword(target[0], "all")) {
    if (target.length < 5 || !["tables", "functions", "routines", "procedures", "sequences"].includes(target[1]?.value)
      || !keyword(target[2], "in") || !keyword(target[3], "schema")) throw new Error("Unsupported all-objects ACL");
    kind = target[1].value === "tables" ? "table" : target[1].value === "sequences" ? "sequence" : "function";
    objects = split(target.slice(4), ",").map((schema) => {
      if (schema.length !== 1) throw new Error("Unsupported ACL schema");
      return { schema: identifier(schema[0]), name: "*" };
    });
  } else objects = split(target, ",").map(kind === "function" ? functionObject : objectName);
  let roles = tokens.slice(roleStart + 1);
  let grantOption = false;
  const withOption = roles.findIndex((token) => keyword(token, "with"));
  if (withOption >= 0) {
    if (action !== "grant" || roles.length !== withOption + 3 || !keyword(roles[withOption + 1], "grant")
      || !keyword(roles[withOption + 2], "option")) throw new Error("Unsupported ACL suffix");
    grantOption = true;
    roles = roles.slice(0, withOption);
  }
  if (action === "revoke" && ["cascade", "restrict"].some((value) => keyword(roles.at(-1), value))) roles = roles.slice(0, -1);
  const names = split(roles, ",").map((part) => {
    if (keyword(part[0], "group")) part = part.slice(1);
    if (part.length !== 1 || ["current_user", "current_role", "session_user"].some((value) => keyword(part[0], value))) {
      throw new Error("Unverifiable ACL recipient");
    }
    return identifier(part[0]);
  });
  return { action, privileges, kind, objects, roles: names, grantOption, optionOnly, columnScoped };
}

export function sameSqlObject(left: SqlObject, right: SqlObject): boolean {
  return left.schema === right.schema && (left.name === "*" || right.name === "*" || (left.name === right.name
    && JSON.stringify(left.args) === JSON.stringify(right.args)));
}

// The one supported interpolated ACL shape derives each complete signature
// from pg_proc.oid::regprocedure, not text supplied by an application or role.
// Match its query and pre-GRANT statements exactly; a new data flow needs review.
function catalogFunctionGrant(tokens: Token[], at: number, expression: Token[], functions: SqlFunction[]): SqlAcl | null {
  const template = "grant execute on function %s to service_role";
  const expectedExpression = lex(`format('${template}',f.signature)`);
  if (JSON.stringify(expression) !== JSON.stringify(expectedExpression)) return null;
  let start = at - 1;
  for (; start >= 0 && !keyword(tokens[start], "for"); start--);
  if (start < 0) return null;
  const header = lex("for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (");
  if (JSON.stringify(tokens.slice(start, start + header.length)) !== JSON.stringify(header)) return null;
  const loop = tokens.findIndex((token, i) => i > start + header.length && keyword(token, "loop"));
  if (loop < 0 || loop >= at || tokens[loop - 1]?.value !== ")") return null;
  const names = split(tokens.slice(start + header.length, loop - 1), ",");
  if (!names.length || names.some((name) => name.length !== 1 || name[0].kind !== "string"
    || !/^[a-z_][a-z_0-9]*$/.test(name[0].value))) return null;
  const before = lex("execute format('revoke all on function %s from public,anon,authenticated',f.signature);");
  if (JSON.stringify(tokens.slice(loop + 1, at)) !== JSON.stringify(before)) return null;
  const objects: SqlObject[] = [];
  for (const name of names) {
    const matches = functions.filter((fn) => fn.object.schema === "public" && fn.object.name === name[0].value);
    if (!matches.length) return null;
    objects.push(...matches.map((fn) => fn.object));
  }
  return { action: "grant", kind: "function", privileges: ["execute"], objects, roles: ["service_role"], grantOption: false, optionOnly: false, columnScoped: false };
}

export function analyzeSqlAcl(source: string): SqlAclAnalysis {
  const analysis: SqlAclAnalysis = { acls: [], functions: [], rls: [], policies: [], triggers: [], triggerEdits: [] };
  const reviewedAppointmentPatch = digest(source) === migrationReview["116_appointment_patch_actor.sql"];
  function visit(tokens: Token[]): void {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if ((token.kind === "body" && keyword(tokens[i - 1], "as"))
        || (["body", "string"].includes(token.kind) && keyword(tokens[i - 1], "do"))) {
        visit(lex(token.value));
      }
      if (keyword(token, "execute") && !["function", "procedure"].some((value) => keyword(tokens[i + 1], value))
        && !keyword(tokens[i - 1], "grant") && !keyword(tokens[i - 1], "revoke")) {
        const end = tokens.findIndex((part, j) => j > i && part.value === ";");
        const expression = tokens.slice(i + 1, end < 0 ? tokens.length : end);
        // This source-pinned DML binds all values and admits only fixed column
        // names. Every altered/extended source still hits the strict rejection.
        if (reviewedAppointmentPatch && JSON.stringify(expression) === JSON.stringify(lex(
          "'update public.appointments set '||assignments||' where workspace_id=$2 and id=$3' using next_row,p_workspace_id,p_appointment_id",
        ))) { i = end; continue; }
        const literal = expression[0]?.kind === "string" ? expression[0]
          : keyword(expression[0], "format") && expression[1]?.value === "(" && expression[2]?.kind === "string" ? expression[2] : null;
        if (!literal) throw new Error("Unverifiable dynamic EXECUTE may grant privileges");
        const dynamicTokens = lex(literal.value);
        const isAcl = dynamicTokens.some((part) => keyword(part, "grant") || keyword(part, "revoke"));
        const concatenated = expression.some((part, j) => part.value === "|" && expression[j + 1]?.value === "|");
        if (concatenated) throw new Error("Unverifiable concatenated dynamic SQL");
        if (isAcl && dynamicTokens.some((part) => keyword(part, "grant"))) {
          if (literal.value.includes("%")) {
            const verified = catalogFunctionGrant(tokens, i, expression, analysis.functions);
            if (!verified) throw new Error("Unverifiable dynamic GRANT interpolation");
            analysis.acls.push(verified);
          } else visit(dynamicTokens);
        } else if (isAcl && !literal.value.includes("%")) visit(dynamicTokens);
        else if (!["select", "revoke", "alter"].some((value) => keyword(dynamicTokens[0], value))) {
          throw new Error("Unverifiable dynamic SQL prefix");
        }
        i = end < 0 ? tokens.length : end;
        continue;
      }
      if (keyword(token, "grant") || keyword(token, "revoke")) {
        let end = tokens.findIndex((part, j) => j > i && part.value === ";");
        if (end < 0) end = tokens.length;
        analysis.acls.push(parseAcl(tokens.slice(i, end)));
        i = end;
        continue;
      }
      if (keyword(token, "create")) {
        const at = keyword(tokens[i + 1], "or") && keyword(tokens[i + 2], "replace") ? i + 3 : i + 1;
        if (keyword(tokens[at], "function")) {
          const open = tokens.findIndex((part, j) => j > at && part.value === "(");
          let depth = 1;
          let close = open + 1;
          for (; close < tokens.length && depth; close++) {
            if (tokens[close].value === "(") depth++;
            else if (tokens[close].value === ")") depth--;
          }
          if (open < 0 || depth) throw new Error("Invalid function declaration");
          const object = functionObject(tokens.slice(at + 1, close));
          let end = tokens.findIndex((part, j) => j >= close && part.value === ";");
          if (end < 0) end = tokens.length;
          const header = tokens.slice(close, end);
          const security = header.flatMap((part, j) => keyword(part, "security") ? [header[j + 1]?.value] : []);
          const paths = header.flatMap((part, j) => keyword(part, "set") && keyword(header[j + 1], "search_path")
            ? [header.slice(j + 2, j + 5)] : []);
          const body = header.find((part, j) => (part.kind === "body" || part.kind === "string") && keyword(header[j - 1], "as"));
          const bodyTokens = body ? lex(body.value) : [];
          if (body?.kind === "string") visit(bodyTokens);
          const references: SqlObject[] = [];
          for (let j = 0; j < bodyTokens.length - 2; j++) {
            if (["word", "quoted"].includes(bodyTokens[j].kind) && bodyTokens[j + 1].value === "."
              && ["word", "quoted"].includes(bodyTokens[j + 2].kind)) references.push(objectName(bodyTokens.slice(j, j + 3)));
          }
          analysis.functions.push({ object, definer: security.length === 1 && security[0] === "definer",
            emptySearchPath: paths.length === 1 && (paths[0][0]?.value === "=" || keyword(paths[0][0], "to"))
              && paths[0][1]?.kind === "string" && paths[0][1].value === ""
              && (!paths[0][2] || ["as", "set", "language", "security", "immutable", "stable", "volatile", "strict", "parallel", "cost", "rows"]
                .some((value) => keyword(paths[0][2], value))), references });
        }
        const trigger = keyword(tokens[at], "constraint") ? at + 1 : at;
        if (keyword(tokens[trigger], "trigger")) {
          const name = identifier(tokens[trigger + 1]);
          const on = tokens.findIndex((part, j) => j > trigger && keyword(part, "on"));
          const end = tokens.findIndex((part, j) => j > trigger && part.value === ";");
          if (on < 0 || end < 0 || on > end) throw new Error("Unverifiable trigger declaration");
          const size = tokens[on + 2]?.value === "." ? 3 : 1;
          const tail = tokens.slice(on + 1 + size, end);
          const execute = tail.findIndex((part) => keyword(part, "execute"));
          if (execute < 0 || !keyword(tail[execute + 1], "function")) throw new Error("Unverifiable trigger function");
          const timing = tokens[trigger + 2]?.value;
          const eventTokens = tokens.slice(trigger + 3, on);
          if (!eventTokens.every((part) => part.kind === "word" && ["insert", "update", "delete", "truncate", "or", "of"].includes(part.value))) {
            // Older UPDATE OF column triggers are irrelevant to receipt proofs.
            // Their target is still recorded; they cannot prove an all-column UPDATE guard.
            analysis.triggers.push({ name, object: objectName(tokens.slice(on + 1, on + 1 + size)),
              fn: functionObject(tail.slice(execute + 2)), timing, events: [], row: false, deferred: false });
          } else analysis.triggers.push({ name, object: objectName(tokens.slice(on + 1, on + 1 + size)),
            fn: functionObject(tail.slice(execute + 2)), timing,
            events: eventTokens.filter((part) => part.value !== "or").map((part) => part.value),
            row: tail.some((part, j) => keyword(part, "for") && keyword(tail[j + 1], "each") && keyword(tail[j + 2], "row")),
            deferred: keyword(tokens[at], "constraint") && tail.some((part, j) => keyword(part, "deferrable")
              && keyword(tail[j + 1], "initially") && keyword(tail[j + 2], "deferred")) });
        }
      }
      if (keyword(token, "alter") && keyword(tokens[i + 1], "table")) {
        let start = i + 2;
        if (keyword(tokens[start], "if") && keyword(tokens[start + 1], "exists")) start += 2;
        if (keyword(tokens[start], "only")) start++;
        const size = tokens[start + 1]?.value === "." ? 3 : 1;
        const mode = tokens[start + size];
        if (["enable", "disable"].some((value) => keyword(mode, value)) && keyword(tokens[start + size + 1], "trigger")) {
          analysis.triggerEdits.push({ object: objectName(tokens.slice(start, start + size)), name: identifier(tokens[start + size + 2]) });
        }
        if (["enable", "disable"].some((value) => keyword(mode, value)) && keyword(tokens[start + size + 1], "row")
          && keyword(tokens[start + size + 2], "level") && keyword(tokens[start + size + 3], "security")) {
          analysis.rls.push({ object: objectName(tokens.slice(start, start + size)), enabled: mode.value === "enable" });
        }
      }
      if (keyword(token, "create") && keyword(tokens[i + 1], "policy")) {
        const on = tokens.findIndex((part, j) => j > i && keyword(part, "on"));
        if (on < 0) throw new Error("Unverifiable RLS policy");
        const size = tokens[on + 2]?.value === "." ? 3 : 1;
        analysis.policies.push(objectName(tokens.slice(on + 1, on + 1 + size)));
      }
      if (keyword(token, "drop") && keyword(tokens[i + 1], "trigger")) {
        const start = keyword(tokens[i + 2], "if") && keyword(tokens[i + 3], "exists") ? i + 4 : i + 2;
        if (!keyword(tokens[start + 1], "on")) throw new Error("Unverifiable DROP TRIGGER");
        const size = tokens[start + 3]?.value === "." ? 3 : 1;
        analysis.triggerEdits.push({ name: identifier(tokens[start]), object: objectName(tokens.slice(start + 2, start + 2 + size)) });
      }
    }
  }
  visit(lex(source));
  return analysis;
}

export function assertNoBrowserFunctionGrants(source: string): void {
  for (const acl of analyzeSqlAcl(source).acls) {
    if (acl.action === "grant" && acl.kind === "function" && acl.privileges.some((name) => ["all", "execute"].includes(name))
      && acl.roles.some((role) => ["public", "anon", "authenticated"].includes(role))) {
      throw new Error(`Browser function grant to ${acl.roles.join(", ")}`);
    }
  }
}
