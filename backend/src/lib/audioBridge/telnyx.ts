import { telnyxClient } from "../telnyx/index.js";
import { audioSessionStore } from "../twenty/audioSession/index.js";
import { encodeState, type BridgeDeps, type BridgeState } from "./index.js";

/**
 * Phone audio needs a Telnyx Call Control application (its webhook URL set
 * to /api/webhooks/telnyx?token=...) and, for Dial in, a number assigned to it.
 */
export function bridgeConfig() {
  return {
    appId: process.env.TELNYX_CALL_CONTROL_APP_ID?.trim() || "",
    dialInNumber: process.env.TELNYX_DIAL_IN_NUMBER?.trim() || "",
    inboundNumber: process.env.TELNYX_INBOUND_NUMBER?.trim() || "",
    fallbackPhone: process.env.TELNYX_FALLBACK_PHONE?.trim() || "",
    agentSipUri: process.env.TELNYX_AGENT_SIP_URI?.trim() || "",
    holdAudioUrl: process.env.TELNYX_HOLD_AUDIO_URL?.trim() || "",
  };
}

const VOICE = { voice: "female", language: "en-US" as const };

export const telnyxBridgeCalls = {
  async answer(callControlId: string, state: BridgeState) {
    await telnyxClient().calls.actions.answer(callControlId, { client_state: encodeState(state) });
  },
  async gather(callControlId: string, prompt: string, state: BridgeState) {
    await telnyxClient().calls.actions.gatherUsingSpeak(callControlId, {
      ...VOICE,
      payload: prompt,
      minimum_digits: 4,
      maximum_digits: 4,
      valid_digits: "0123456789",
      terminating_digit: "#",
      timeout_millis: 20_000,
      client_state: encodeState(state),
    });
  },
  async speak(callControlId: string, text: string, state: BridgeState) {
    await telnyxClient().calls.actions.speak(callControlId, { ...VOICE, payload: text, client_state: encodeState(state) });
  },
  async hangup(callControlId: string) {
    await telnyxClient().calls.actions.hangup(callControlId, {});
  },
  /** Places a call; returns its call_control_id. */
  async dial(params: {
    to: string;
    from: string;
    state: BridgeState;
    linkTo?: string;
    commandId?: string;
    callerNumber?: string;
    record?: boolean;
    timeoutSecs?: number;
  }): Promise<string> {
    const { appId } = bridgeConfig();
    const res = await telnyxClient().calls.dial({
      connection_id: appId,
      to: params.to,
      from: params.from,
      client_state: encodeState(params.state),
      timeout_secs: params.timeoutSecs ?? 30,
      ...(params.commandId ? { command_id: params.commandId } : {}),
      ...(params.callerNumber && /^sips?:/i.test(params.to) && /^\+[1-9]\d{6,14}$/.test(params.callerNumber)
        ? { custom_headers: [{ name: "X-Dialer-Original-Caller", value: params.callerNumber }] }
        : {}),
      ...(params.linkTo
        ? { link_to: params.linkTo, bridge_on_answer: true, park_after_unbridge: "self" }
        : {}),
      ...(params.record ? { record: "record-from-answer" as const, record_format: "mp3" as const, record_channels: "dual" as const } : {}),
    });
    const id = res?.data?.call_control_id;
    if (!id) throw new Error("Telnyx did not return a call_control_id");
    return id;
  },
};

export const telnyxIncomingCalls = {
  async answer(callControlId: string, state: BridgeState, commandId?: string) {
    await telnyxClient().calls.actions.answer(callControlId, {
      client_state: encodeState(state),
      ...(commandId ? { command_id: commandId } : {}),
    });
  },
  async playback(callControlId: string, audioUrl: string, state: BridgeState) {
    await telnyxClient().calls.actions.startPlayback(callControlId, {
      audio_type: "mp3",
      audio_url: audioUrl,
      cache_audio: true,
      client_state: encodeState(state),
      command_id: `inbound-hold-${state.sessionId}`,
      loop: "infinity",
      target_legs: "self",
    });
  },
  async stopPlayback(callControlId: string, commandId?: string) {
    await telnyxClient().calls.actions.stopPlayback(callControlId, {
      stop: "all",
      ...(commandId ? { command_id: commandId } : {}),
    });
  },
  dial: (params: {
    to: string;
    from: string;
    state: BridgeState;
    linkTo: string;
    timeoutSecs: number;
    commandId?: string;
    callerNumber?: string;
  }) => telnyxBridgeCalls.dial(params),
};

export function bridgeDeps(): BridgeDeps {
  return {
    store: audioSessionStore,
    calls: telnyxBridgeCalls,
    dialInNumber: bridgeConfig().dialInNumber || null,
    now: () => new Date(),
  };
}
