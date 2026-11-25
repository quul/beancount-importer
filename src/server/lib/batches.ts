import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { GenerateResult, ImportPreview, ReviewExclusionKind, ReviewStatusUndo, TxStatus } from "../../shared/types.js";

export type StoredPdfUpload = string | { archiveName: string };

export interface StoredBatch extends ImportPreview {
  batchId: string;
  createdAt: number;
  revision: number;
  committed: boolean;
  /** Never allow an old batch to follow a change to the configured ledger. */
  ledgerProfile: string;
  /** Storage names of the original PDFs, keyed by their upload digest. */
  pdfUploads?: Record<string, StoredPdfUpload>;
  preview?: { revision: number; result: GenerateResult; opens: string[] };
  reviewStatusHistory?: {
    sessionId: string;
    operations: Array<{
      action: ReviewStatusUndo["action"];
      entries: Array<{ id: string; before: TxStatus; after: TxStatus; beforeExclusion?: ReviewExclusionKind; afterExclusion?: ReviewExclusionKind }>;
    }>;
  };
  mergedFrom?: string[];
}

export const isBatchId = (id: string) => /^b\d+-[a-f0-9]{12}$/.test(id);

export function profileId(root: string, main: string): string {
  const absoluteRoot = path.resolve(root);
  const canonicalRoot = fs.existsSync(absoluteRoot) ? fs.realpathSync(absoluteRoot) : absoluteRoot;
  const resolvedMain = path.resolve(canonicalRoot, main);
  const canonicalMain = fs.existsSync(resolvedMain) ? fs.realpathSync(resolvedMain) : resolvedMain;
  return crypto.createHash("sha256").update(canonicalMain).digest("hex").slice(0, 20);
}

export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export class BatchStore {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }

  private file(id: string): string {
    if (!isBatchId(id)) throw new Error("无效的批次 ID");
    return path.join(this.directory, `${id}.json`);
  }

  private archivePointer(id: string): string {
    return path.join(path.dirname(this.file(id)), "merged-into", `${id}.json`);
  }

  private removedMerge(id: string): string {
    return path.join(path.dirname(this.file(id)), "removed-merges", `${id}.json`);
  }

  mergedInto(id: string): string | undefined {
    if (!isBatchId(id)) return undefined;
    try {
      const target: unknown = JSON.parse(fs.readFileSync(this.archivePointer(id), "utf8"));
      if (typeof target === "string" && isBatchId(target)
        && (this.has(target) || fs.existsSync(this.removedMerge(target)))) return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  create(input: Omit<StoredBatch, "batchId" | "createdAt" | "revision" | "committed" | "mergedInto">): StoredBatch {
    const batch: StoredBatch = {
      ...input,
      batchId: `b${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
      createdAt: Date.now(),
      revision: 1,
      committed: false,
    };
    // Pointers become active together when the new batch is atomically published.
    for (const id of batch.mergedFrom ?? []) atomicJson(this.archivePointer(id), batch.batchId);
    this.save(batch);
    return batch;
  }

  get(id: string): StoredBatch | undefined {
    try {
      const batch = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as StoredBatch;
      const mergedInto = this.mergedInto(id);
      return mergedInto ? { ...batch, mergedInto } : batch;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  has(id: string): boolean {
    return isBatchId(id) && fs.existsSync(this.file(id));
  }

  remove(id: string): void {
    if (this.get(id)?.mergedFrom?.length) atomicJson(this.removedMerge(id), true);
    fs.unlinkSync(this.file(id));
  }

  save(batch: StoredBatch): void {
    atomicJson(this.file(batch.batchId), batch);
  }

  list(): StoredBatch[] {
    return fs.readdirSync(this.directory)
      .filter((name) => /^b\d+-[a-f0-9]{12}\.json$/.test(name))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((batch): batch is StoredBatch => !!batch)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
