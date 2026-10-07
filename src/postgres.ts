import type {Pool, PoolClient} from 'pg';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import type {KVLikeStorage} from './core/ledger';

export function schemaName(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid PostgreSQL schema');
  return `"${schema}"`;
}
export async function initializeDatabase(pool: Pool, schema = 'notion_caldav_sync'): Promise<void> {
  const name = schemaName(schema);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${name}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${name}.state (key TEXT PRIMARY KEY, envelope JSONB NOT NULL)`);
}

/** Autocommit acknowledged pairs while holding the run's session advisory lock. */
export class PostgresState implements KVLikeStorage {
  private key: Buffer;
  private table: string;
  constructor(private client: PoolClient, key: string, schema = 'notion_caldav_sync') {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw Error('DATA_ENCRYPTION_KEY must contain 64 hexadecimal characters');
    this.key = Buffer.from(key,'hex');
    this.table = `${schemaName(schema)}.state`;
  }
  async get(key: string): Promise<unknown> {
    const result = await this.client.query(`SELECT envelope FROM ${this.table} WHERE key=$1`,[key]);
    return result.rows[0] ? this.decrypt(key,result.rows[0].envelope) : undefined;
  }
  async put(key: string,value: unknown): Promise<void> {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(this.table+':'+key));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    const envelope = {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')};
    await this.client.query(`INSERT INTO ${this.table}(key,envelope) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET envelope=EXCLUDED.envelope`,[key,JSON.stringify(envelope)]);
  }
  async delete(key: string): Promise<void> { await this.client.query(`DELETE FROM ${this.table} WHERE key=$1`,[key]); }
  async list(options?: {prefix?:string}) {
    const prefix = options?.prefix || '';
    const result = await this.client.query(`SELECT key FROM ${this.table} WHERE starts_with(key,$1) ORDER BY key LIMIT 5001`,[prefix]);
    if (result.rows.length>5000) throw Error('Ledger size limit reached');
    return {keys:result.rows.map(row=>String(row.key))};
  }
  async listAll(): Promise<Array<Record<string,unknown>>> {
    const result = await this.client.query(`SELECT key,envelope FROM ${this.table} WHERE starts_with(key,'ledger:') ORDER BY key LIMIT 5001`);
    if (result.rows.length>5000) throw Error('Ledger size limit reached');
    return result.rows.map(row=>this.decrypt(row.key,row.envelope) as Record<string,unknown>);
  }
  private decrypt(key: string,envelope: {v:number;iv:string;tag:string;data:string}): unknown {
    if (envelope.v!==1) throw Error('Unsupported encrypted state format');
    const decipher = createDecipheriv('aes-256-gcm',this.key,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(Buffer.from(this.table+':'+key));
    decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
  }
}
