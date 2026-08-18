export interface DocumentTaskToken {
  documentId: string;
  jobId: string;
  revision: number;
}

type TaskPhase = "active" | "cancelling";

interface DocumentTaskState {
  token: DocumentTaskToken;
  phase: TaskPhase;
}

export class DocumentSessionCoordinator {
  private readonly tasks = new Map<string, DocumentTaskState>();
  private readonly revisions = new Map<string, number>();
  private readonly polls = new Map<string, Promise<unknown>>();

  begin(documentId: string, createJobId: () => string): DocumentTaskToken {
    const existing = this.tasks.get(documentId);
    if (existing) return existing.token;
    const revision = (this.revisions.get(documentId) ?? 0) + 1;
    this.revisions.set(documentId, revision);
    const token = { documentId, jobId: createJobId(), revision };
    this.tasks.set(documentId, { token, phase: "active" });
    return token;
  }

  current(documentId: string) {
    return this.tasks.get(documentId)?.token ?? null;
  }

  cancel(documentId: string) {
    const current = this.tasks.get(documentId);
    if (!current) return null;
    current.phase = "cancelling";
    return current.token;
  }

  finishCancellation(token: DocumentTaskToken) {
    const current = this.tasks.get(token.documentId);
    if (current?.phase === "cancelling" && this.same(current.token, token)) {
      this.tasks.delete(token.documentId);
    }
  }

  finish(token: DocumentTaskToken) {
    const current = this.tasks.get(token.documentId);
    if (current && this.same(current.token, token)) this.tasks.delete(token.documentId);
  }

  accepts(token: DocumentTaskToken) {
    const current = this.tasks.get(token.documentId);
    return Boolean(current && current.phase === "active" && this.same(current.token, token));
  }

  sessionCount() {
    return this.tasks.size;
  }

  poll<T>(documentId: string, jobId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${documentId}\u0000${jobId}`;
    const existing = this.polls.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const current = operation().finally(() => {
      if (this.polls.get(key) === current) this.polls.delete(key);
    });
    this.polls.set(key, current);
    return current;
  }

  closeDocument(documentId: string) {
    this.tasks.delete(documentId);
    for (const key of Array.from(this.polls.keys())) {
      if (key.startsWith(`${documentId}\u0000`)) this.polls.delete(key);
    }
  }

  private same(a: DocumentTaskToken, b: DocumentTaskToken) {
    return a.documentId === b.documentId && a.jobId === b.jobId && a.revision === b.revision;
  }
}
