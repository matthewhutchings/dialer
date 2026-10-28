export const QUEUE_STATUSES = ["READY", "CALLBACK", "COMPLETED", "SKIPPED", "DO_NOT_CALL"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export interface CrmQueuePerson {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  companyId: string | null;
  companyName: string | null;
  personUrl: string;
  companyUrl: string | null;
}

export interface DialerQueue {
  id: string;
  name: string;
}

export interface DialerQueueEntry {
  id: string;
  queueId: string | null;
  personId: string | null;
  companyId: string | null;
  status: QueueStatus;
  preCallNotes: string;
  nextCallAt: string | null;
  sortOrder: number;
  person: CrmQueuePerson | null;
}
