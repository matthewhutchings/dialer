export interface CallTask {
  id: string;
  title: string;
  description: string;
  status: string;
  dueAt: string | null;
  assigneeId: string | null;
  contacts: { type: "prospect" | "lead"; id: string }[];
}

export interface CallTaskSync {
  created: number | null;
  error: string | null;
}
