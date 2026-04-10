declare module "better-auth/db/migration" {
  export function getMigrations(options: unknown): Promise<{
    runMigrations(): Promise<void>;
  }>;
}
