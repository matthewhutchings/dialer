import { v5 as uuidv5 } from "uuid";
import { telnyxClient, telnyxErrorMessage } from "../../telnyx/index.js";
import { createTwenty, getTwenty, listTwenty, updateTwenty } from "../../twenty/client/index.js";
import { createLogger } from "../../logger/index.js";
import type { AgencyCall } from "../../../routes/calls/types.js";

const log = createLogger("recording-transcription");
export const RECORDING_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
const reservationId = (recordingId: string) => uuidv5(`recording-transcription:${recordingId}`, uuidv5.URL);
interface Reservation { id: string; state: string; transcript?: string }
const reservations = "agencyRecordingTranscriptions";

async function reservation(recordingId: string): Promise<Reservation | undefined> {
  const [row] = await listTwenty<Reservation>(reservations, {
    limit: 1, filter: `id[eq]:"${reservationId(recordingId)}"`,
  });
  return row;
}

export async function hasRecordingTranscription(callId: string): Promise<boolean> {
  const call = await getTwenty<AgencyCall>("agencyCalls", callId);
  return !!call.telnyxRecordingId && !!await reservation(call.telnyxRecordingId);
}

/**
 * One paid attempt per recording, across servers and webhook redelivery.
 * Never release an uncertain attempt: retrying a timed-out POST can bill twice.
 */
export async function transcribeRecording(callId: string): Promise<string | null> {
  const call = await getTwenty<AgencyCall>("agencyCalls", callId);
  if (call.transcript?.trim()) return null;
  if (call.aiVoiceRequestId) {
    log.info(`AI assistant conversation events own the transcript for call=${callId}; no recording transcription will be requested.`);
    return null;
  }
  if (!call.telnyxRecordingId) throw new Error("The call has no Telnyx recording ID.");
  const tx = telnyxClient();
  let saved = await reservation(call.telnyxRecordingId);
  if (!saved) {
    const recording = await tx.recordings.retrieve(call.telnyxRecordingId);
    const url = recording.data?.download_urls?.wav || recording.data?.download_urls?.mp3;
    if (!url) throw new Error("Telnyx has no downloadable audio for this recording.");
    const id = reservationId(call.telnyxRecordingId);
    try {
      saved = await createTwenty<Reservation>(reservations, {
        id, name: `Recording transcription ${callId}`, state: "SUBMITTED",
        callId, recordingId: call.telnyxRecordingId, model: RECORDING_TRANSCRIPTION_MODEL,
      });
    } catch (err) {
      // Another worker won, or the successful reservation response was lost.
      if (await reservation(call.telnyxRecordingId)) {
        log.warn(`Transcription reservation already exists for call=${callId}; no second request will be sent.`);
        return null;
      }
      throw err;
    }
    if (saved.id !== id) throw new Error("Twenty did not preserve the transcription reservation ID. No audio request was sent.");
    try {
      await updateTwenty("agencyCalls", callId, { transcriptionStatus: "PENDING" });
      const result = await tx.ai.audio.transcribe({
        model: RECORDING_TRANSCRIPTION_MODEL, language: "en", file_url: url, response_format: "json",
      }, { maxRetries: 0, timeout: 120_000 });
      const text = result.text?.trim();
      if (!text) throw new Error("Telnyx Whisper returned an empty transcript.");
      // Cache the result before the call write so a failed CRM write can recover without another paid pass.
      saved = await updateTwenty<Reservation>(reservations, id, { state: "COMPLETED", transcript: text });
    } catch (err) {
      log.error(`Transcription attempt failed or is uncertain for call=${callId}: ${telnyxErrorMessage(err)}`);
      await updateTwenty("agencyCalls", callId, { transcriptionStatus: "FAILED" });
      throw new Error("Recording transcription failed or its result is uncertain. Automatic resubmission is disabled to prevent duplicate charges.");
    }
  }
  if (saved.state === "SUBMITTED") {
    log.warn(`Transcription already submitted for call=${callId}; no second request will be sent.`);
    return null;
  }
  if (saved.state !== "COMPLETED" || !saved.transcript?.trim()) {
    throw new Error("The saved transcription result is invalid.");
  }
  await updateTwenty("agencyCalls", callId, { transcript: saved.transcript, transcriptionStatus: "READY" });
  return saved.transcript;
}
