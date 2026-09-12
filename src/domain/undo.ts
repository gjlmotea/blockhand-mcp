export interface UndoStatus {
  readonly enabled: boolean;
  readonly maxBlocks: number;
  readonly maxRegions: number;
  readonly state: 'empty' | 'ready' | 'uncertain' | 'partial' | 'cleanup-required' | 'invalidated';
  readonly busy: boolean;
  readonly available: boolean;
  readonly operationId: string | null;
  readonly storedBlocks: number;
  readonly snapshotCount: number;
  readonly restoredRegions: number;
  readonly backupMs: number;
  readonly checkMs: number;
  readonly restoreMs: number;
  readonly reason: string | null;
}

export interface UndoController {
  status(): UndoStatus;
  configure(enabled?: boolean, maxBlocks?: number, clear?: boolean): Promise<UndoStatus>;
  undo(operationId?: string, overwriteChanges?: boolean): Promise<UndoStatus>;
}
