// The parts of an n8n workflow this CLI reads. n8n sends many more fields; they pass
// through untouched, so these types list only what the code depends on.

export type WorkflowNode = {
  id?: string;
  name?: string;
  type?: string;
  typeVersion?: number;
  disabled?: boolean;
  webhookId?: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string; name?: string } | undefined>;
  [key: string]: unknown;
};

export type Tag = { id: string; name: string; [key: string]: unknown };

export type Workflow = {
  id?: string;
  name?: string;
  active?: boolean;
  isArchived?: boolean;
  nodes?: WorkflowNode[];
  connections?: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  pinData?: Record<string, unknown>;
  tags?: Tag[];
  createdAt?: string;
  updatedAt?: string;
  activeVersion?: { nodes?: WorkflowNode[]; connections?: Record<string, unknown>; [key: string]: unknown } | null;
  _backup_metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type Execution = {
  id: string;
  workflowId: string;
  status: string;
  mode?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
  finished?: boolean;
  retryOf?: string | null;
  retrySuccessId?: string | null;
  waitTill?: string | null;
  [key: string]: unknown;
};
