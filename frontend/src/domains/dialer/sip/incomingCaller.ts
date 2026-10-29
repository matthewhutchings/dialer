interface IncomingSession {
  request?: { getHeader(name: string): string | undefined };
  remoteIdentity?: { uri?: { user?: string }; displayName?: string };
}

export function incomingCaller(session: IncomingSession): { number: string; name: string } {
  const original = session.request?.getHeader("X-Dialer-Original-Caller");
  if (original === "anonymous") return { number: "Withheld", name: "Withheld caller" };
  if (original && /^\+[1-9]\d{6,14}$/.test(original)) {
    return { number: original, name: original };
  }
  const number = session.remoteIdentity?.uri?.user ?? "Unknown";
  return { number, name: session.remoteIdentity?.displayName || number };
}
