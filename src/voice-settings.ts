import { randomUUID } from 'node:crypto';
import {
  defaultVoiceOptions,
  saveVoiceSettingsSchema,
  voiceOptionsSchema,
  voiceOverrideSchema,
  type VoiceReadiness,
  type VoiceSettings,
} from './demo-contract.ts';
import { fail, readState, stateFile, writeState } from './local-state.ts';

// Retain previous references for child-process scrubbing after settings are changed.
const secretVariables = new Set<string>(['E2E_SPEECH_API_KEY']);
export function getVoiceSettings(): VoiceSettings {
  const settings = readState<VoiceSettings>(stateFile('voice-settings.json'), {
    ...defaultVoiceOptions,
    revision: 'voice-v1',
    speechCredentialRef: null,
  });
  if (settings.speechCredentialRef?.startsWith('env://')) secretVariables.add(settings.speechCredentialRef.slice(6));
  return settings;
}
export function voiceReadiness(): VoiceReadiness {
  const settings = getVoiceSettings(),
    ref = settings.speechCredentialRef;
  return {
    settings,
    speech: {
      status: !ref ? 'not-configured' : ref.startsWith('env://') && !process.env[ref.slice(6)] ? 'missing' : 'configured',
      verified: false,
    },
  };
}
export function saveVoiceSettings(input: unknown) {
  const parsed = saveVoiceSettingsSchema.parse(input);
  if (parsed.expectedRevision !== getVoiceSettings().revision) fail('REVISION_CONFLICT', 'Voice settings changed; reload before saving');
  const settings: VoiceSettings = {
    ...parsed.options,
    speechCredentialRef: parsed.speechCredentialRef,
    revision: randomUUID(),
  };
  writeState(stateFile('voice-settings.json'), settings);
  return voiceReadiness();
}
export const effectiveVoiceOptions = (override?: unknown) => {
  const { revision, speechCredentialRef, ...options } = getVoiceSettings();
  return voiceOptionsSchema.parse({
    ...options,
    ...voiceOverrideSchema.parse(override ?? {}),
  });
};
export function scrubSpeechCredentials(env: NodeJS.ProcessEnv) {
  getVoiceSettings();
  for (const name of secretVariables) delete env[name];
}
