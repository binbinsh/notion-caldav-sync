import { LedgerRecord } from "./models";

export interface SyncLedger {
  getRecord(pageId: string): Promise<LedgerRecord | null>;
  putRecord(record: LedgerRecord): Promise<LedgerRecord>;
  deleteRecord(pageId: string): Promise<void>;
  listRecords(): Promise<LedgerRecord[]>;
}

export class InMemoryLedger implements SyncLedger {
  #records = new Map<string, Record<string, unknown>>();

  async getRecord(pageId: string): Promise<LedgerRecord | null> {
    const payload = this.#records.get(pageId);
    return payload ? LedgerRecord.fromJSON(payload, pageId) : null;
  }

  async putRecord(record: LedgerRecord): Promise<LedgerRecord> {
    this.#records.set(record.pageId, record.toJSON());
    return record;
  }

  async deleteRecord(pageId: string): Promise<void> {
    this.#records.delete(pageId);
  }

  async listRecords(): Promise<LedgerRecord[]> {
    return [...this.#records.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pageId, payload]) => LedgerRecord.fromJSON(payload, pageId));
  }
}

export interface KVLikeStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys?: Array<string | { name?: string }> } | unknown>;
}

export class StorageLedger implements SyncLedger {
  constructor(
    private readonly storage: KVLikeStorage,
    private readonly prefix = "ledger:",
  ) {}

  private recordKey(pageId: string): string {
    return `${this.prefix}${pageId}`;
  }

  async getRecord(pageId: string): Promise<LedgerRecord | null> {
    const payload = await this.storage.get(this.recordKey(pageId));
    return payload && typeof payload === "object"
      ? LedgerRecord.fromJSON(payload as Record<string, unknown>, pageId)
      : null;
  }

  async putRecord(record: LedgerRecord): Promise<LedgerRecord> {
    await this.storage.put(this.recordKey(record.pageId), record.toJSON());
    return record;
  }

  async deleteRecord(pageId: string): Promise<void> {
    await this.storage.delete(this.recordKey(pageId));
  }

  async listRecords(): Promise<LedgerRecord[]> {
    const payload = await this.storage.list({ prefix: this.prefix });
    const keys =
      typeof payload === "object" && payload !== null && "keys" in payload
        ? ((payload as { keys?: Array<string | { name?: string }> }).keys || [])
        : [];

    const records: LedgerRecord[] = [];
    for (const entry of keys) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!name || !name.startsWith(this.prefix)) {
        continue;
      }
      const pageId = name.slice(this.prefix.length);
      const record = await this.getRecord(pageId);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }
}
