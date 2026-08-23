/**
 * React UI of the call button, rendered into the shadow root of `<cc-call-button>` by
 * `call-button.ts`. Owns nothing but presentation: the call itself lives in
 * `useCall.ts`, the texts in `locales/*.json` (one i18next instance per element).
 */
import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { createEmbedI18n } from './i18n.ts';
import { MISSING_KEY, type PeerInfo, statusKey } from './state.ts';
import { styles } from './styles.ts';
import { useCall } from './useCall.ts';

/** Props of {@link CallButton}; the element maps its attributes onto them. */
export type CallButtonProps = {
  /** Public embed key (`pk_…`). */
  embedKey: string;
  /** Queue key to ring. */
  queue: string;
  /** Origin of the API. */
  api: string;
  /** Text of the idle button; `undefined` shows the translated "Call us". */
  label: string | undefined;
  /** The customer's language (BCP 47): picks the translation and is sent for routing. */
  language: string | undefined;
};

/** One `<cc-call-button>`: styles, the buttons, the status line and the audio holder. */
export function CallButton(props: CallButtonProps) {
  const i18n = useMemo(() => createEmbedI18n(props.language), [props.language]);
  return (
    <I18nextProvider i18n={i18n}>
      <Inner {...props} />
    </I18nextProvider>
  );
}

/** `t('peers.ai')` or `t('peers.agent', { name })`, trimmed when the agent has no name. */
const peerText = (t: TFunction, peer: PeerInfo) =>
  peer.kind === 'ai' ? t('peers.ai') : t('peers.agent', { name: peer.name }).trim();

function Inner({ embedKey, queue, api, label, language }: CallButtonProps) {
  const { t } = useTranslation();
  const { state, now, start, hangUp, toggleMute, audioRef } = useCall({
    embedKey,
    queue,
    api,
    language,
  });
  const status = statusKey(state, now);
  let text = '';
  if (status.key === 'inCall') {
    text = t('inCall', { with: peerText(t, status.peer), duration: status.duration });
  } else if (status.key === 'couldNotStart') {
    const message = status.message === MISSING_KEY ? t('missingKey') : status.message;
    text = t('couldNotStart', { message });
  } else if (status.key) {
    text = t(status.key);
  }
  const inCall = state.kind === 'in_call' || state.kind === 'waiting';
  return (
    <>
      <style>{styles}</style>
      <div className="row">
        {inCall ? (
          <>
            <button
              className="secondary"
              aria-pressed={state.kind === 'in_call' && state.muted}
              onClick={() => void toggleMute()}
            >
              {state.kind === 'in_call' && state.muted ? t('unmute') : t('mute')}
            </button>
            <button className="danger" onClick={() => void hangUp()}>
              {t('hangUp')}
            </button>
          </>
        ) : (
          <button disabled={state.kind === 'connecting'} onClick={() => void start()}>
            {label ?? t('callUs')}
          </button>
        )}
      </div>
      <div className="status" role="status" aria-live="polite">
        {text}
      </div>
      <div ref={audioRef} />
    </>
  );
}
