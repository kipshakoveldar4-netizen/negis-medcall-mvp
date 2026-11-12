export type MigrationRecord = { file: string; source: string };
export type MigrationToken = { kind: "identifier" | "string" | "body" | "word" | "symbol"; value: string; offset: number; bodyStart?: number };
export type MigrationEvidence = {
  extensions: Array<{ name: string; line: number }>;
  notifications: number[];
  tables: string[];
  rls: string[];
  functions: Array<{ name: string; body: string; line: number }>;
  dynamicSqlLines: number[];
  storageCatalogueLines: number[];
};
export type ReviewedMigration = Readonly<MigrationRecord & { sha256: string; evidence: MigrationEvidence }>;
export const migrationReview: Readonly<Record<string, string>>;
export function digest(source: string | Uint8Array): string;
export function migrationTokens(source: string): MigrationToken[];
export function inspectMigration(source: string): MigrationEvidence;
export function preflightChain(records: MigrationRecord[]): ReviewedMigration[];
export function readReviewedChain(directory: string): Promise<ReviewedMigration[]>;
