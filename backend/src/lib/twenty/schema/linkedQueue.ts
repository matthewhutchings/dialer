import { QUEUE_STATUSES } from "@dialer/shared";
import type { SchemaManifest, SchemaRelation } from "./types.js";

const relation = (object: string, name: string, target: string, inverse: string, inverseLabel: string): SchemaRelation => ({
  object, name, label: name === "queueEntry" ? "Queue Entry" : name[0].toUpperCase() + name.slice(1),
  icon: "IconRelationOneToMany", target, targetFieldName: inverse, targetFieldLabel: inverseLabel,
  targetFieldIcon: "IconPhone", onDelete: "SET_NULL",
});

export const LINKED_QUEUE_SCHEMA: SchemaManifest = {
  objects: [
    {
      nameSingular: "dialerQueue", namePlural: "dialerQueues",
      labelSingular: "Dialer Queue", labelPlural: "Dialer Queues",
      description: "Calling worklists linked to Twenty People and Companies.", icon: "IconList",
      fields: [],
    },
    {
      nameSingular: "dialerQueueEntry", namePlural: "dialerQueueEntries",
      labelSingular: "Dialer Queue Entry", labelPlural: "Dialer Queue Entries",
      description: "One person per queue. Contact information stays on Twenty People and Companies.", icon: "IconPhone",
      fields: [
        { name: "enrollmentKey", label: "Enrollment Key", type: "TEXT", isNullable: false, isUnique: true, description: "Unique queue UUID:person UUID. Prevents repeat enrollment, including concurrent imports." },
        { name: "status", label: "Status", type: "SELECT", defaultValue: "'READY'", options: QUEUE_STATUSES.map((value) => ({ value, label: value.replaceAll("_", " "), color: value === "COMPLETED" ? "green" : value === "DO_NOT_CALL" ? "red" : "gray" })) },
        { name: "preCallNotes", label: "Pre-call Research / AI Notes", type: "TEXT", description: "Research brief available before dialing, separate from call notes and post-call AI analysis." },
        { name: "nextCallAt", label: "Next Call At", type: "DATE_TIME" },
        { name: "sortOrder", label: "Queue Order", type: "NUMBER", settings: { type: "int" } },
      ],
    },
  ],
  relations: [
    relation("dialerQueueEntry", "queue", "dialerQueue", "entries", "Entries"),
    relation("dialerQueueEntry", "person", "person", "dialerQueueEntries", "Dialer Queue Entries"),
    relation("dialerQueueEntry", "company", "company", "dialerQueueEntries", "Dialer Queue Entries"),
    relation("dialerQueueEntry", "assignedTo", "workspaceMember", "assignedQueueEntries", "Assigned Queue Entries"),
    relation("agencyCall", "person", "person", "dialerCalls", "Dialer Calls"),
    relation("agencyCall", "company", "company", "dialerCalls", "Dialer Calls"),
    relation("agencyCall", "queueEntry", "dialerQueueEntry", "calls", "Calls"),
  ],
};
