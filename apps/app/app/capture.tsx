import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Platform, Share, StyleSheet, View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Screen } from '../src/components/Screen';
import { StepBar } from '../src/components/StepBar';
import { UnavailableNotice } from '../src/components/UnavailableNotice';
import { captureErrorMessage, useCaptureFlow } from '../src/hooks/useCaptureFlow';
import type { CaptureFlowState, CaptureMetaEnv } from '../src/hooks/useCaptureFlow';
import { isSessionComplete } from '../src/lib/captureSession';
import { hasSupabaseConfig } from '../src/lib/supabase';
import { uploadErrorMessage } from '../src/lib/upload';
import type { Leg } from '../src/lib/upload';
import type { CaptureState, PhotoCaptureMode } from '../modules/forms-capture';
import { colors, radius, spacing } from '../src/theme/tokens';

/** Device/OS context stamped onto the scan. Built here (not in useCaptureFlow)
 * so react-native stays out of that module's node-test import graph. Platform
 * exposes OS and version; a precise device model needs a native module we have
 * not added yet, so it is left null for now. */
function readCaptureEnv(): CaptureMetaEnv {
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version ?? ''),
    deviceModel: null,
  };
}

/**
 * The guided capture flow, one phase per screen. All state logic lives in
 * useCaptureFlow; backing out unmounts the hook, which cancels any in-flight
 * native work and removes event listeners.
 */
export default function CaptureScreen() {
  const router = useRouter();
  const { state, start, retryUpload, nextLeg, choosePhotoMode } = useCaptureFlow({
    pair: true,
    captureEnv: readCaptureEnv,
  });
  const session = state.session;
  const pairComplete = session != null && isSessionComplete(session);

  // Once both legs are saved, open the pair. replace() so the back button does
  // not land on a finished capture. Without a backend the uploads are simulated
  // and the files exist only on this phone, so stay here (UploadedSection).
  useEffect(() => {
    if (state.phase === 'uploaded' && pairComplete && session && hasSupabaseConfig()) {
      router.replace({ pathname: '/scan/[key]', params: { key: session.pairId, fresh: '1' } });
    }
  }, [state.phase, pairComplete, session, router]);

  switch (state.phase) {
    case 'unsupported':
      return (
        <Screen
          footer={
            <Button variant="outline" onPress={router.back}>
              Back
            </Button>
          }
        >
          <UnavailableNotice reason={state.unavailableReason} />
        </Screen>
      );
    case 'ready':
      return <ReadySection state={state} onStart={start} onChoosePhotoMode={choosePhotoMode} />;
    case 'capturing':
      return <CapturingSection state={state} />;
    case 'reconstructing':
      return <ReconstructingSection state={state} />;
    case 'done':
    case 'uploading':
      return <UploadingSection state={state} />;
    case 'uploaded':
      return <UploadedSection state={state} pairComplete={pairComplete} onNextLeg={nextLeg} />;
    case 'upload_failed':
      return <UploadFailedSection state={state} onRetry={retryUpload} onRescan={start} />;
    case 'failed':
      return <FailedSection state={state} onRetry={start} />;
    default:
      return (
        <Screen>
          <ActivityIndicator color={colors.textPrimary} accessibilityLabel="Checking this phone" />
        </Screen>
      );
  }
}

// ---------------------------------------------------------------------------
// Phase sections
// ---------------------------------------------------------------------------

const LEG_TITLE: Record<Leg, string> = { L: 'Left leg', R: 'Right leg' };
const LEG_STEP: Record<Leg, number> = { L: 1, R: 2 };

function LegHeader({ leg, title }: { leg: Leg; title?: string }) {
  return (
    <>
      <StepBar step={LEG_STEP[leg]} total={2} />
      <Heading level="display">{title ?? LEG_TITLE[leg]}</Heading>
      <View style={{ height: spacing.lg }} />
    </>
  );
}

/** Photos mode steps per answer to "Is someone helping you?". */
const PHOTO_STEPS: Record<PhotoCaptureMode, string[]> = {
  solo: [
    'Sit on a chair, foot flat on the floor, other leg moved out of the way.',
    'Point the circle at the front of your shin, halfway up, and tap.',
    'Sweep the phone from the inner side, across the front, to the outer side, then reach behind as far as is comfortable. Switch hands for the far side.',
  ],
  helper: [
    'Stand or sit still.',
    'Your helper points the circle at the front of your shin, halfway up, and taps.',
    "Your helper walks one slow, full circle around your leg at arm's length.",
  ],
};

const PHOTO_TITLE: Record<PhotoCaptureMode, string> = {
  solo: 'Sweep the phone around your leg.',
  helper: 'Your helper walks one slow circle.',
};

const PHOTO_TARGET: Record<PhotoCaptureMode, string> = {
  solo: 'Done unlocks at about half way around, with the front and both sides covered.',
  helper: 'Done unlocks once the ring is almost full.',
};

function ReadySection({
  state,
  onStart,
  onChoosePhotoMode,
}: {
  state: CaptureFlowState;
  onStart: () => void;
  onChoosePhotoMode: (mode: PhotoCaptureMode | null) => void;
}) {
  const { mode, leg, photoMode } = state;

  if (mode === 'photos' && photoMode === null) {
    return (
      <Screen
        footer={
          <>
            <Button onPress={() => onChoosePhotoMode('solo')}>No, I am on my own</Button>
            <Button variant="outline" onPress={() => onChoosePhotoMode('helper')}>
              Yes, someone is helping
            </Button>
          </>
        }
      >
        <LegHeader leg={leg} />
        <Heading level="h2">Is someone helping you?</Heading>
        <View style={{ height: spacing.md }} />
        <Body color={colors.textSecondary}>
          On your own, you cover the front and sides from a chair. A helper can walk all the way
          around.
        </Body>
      </Screen>
    );
  }

  if (mode === 'photos' && photoMode !== null) {
    return (
      <Screen
        footer={
          <>
            <Button onPress={() => onStart()}>Start</Button>
            <Button
              variant="text"
              onPress={() => onChoosePhotoMode(photoMode === 'helper' ? 'solo' : 'helper')}
            >
              {photoMode === 'helper' ? 'I am on my own instead' : 'Someone is helping me instead'}
            </Button>
          </>
        }
      >
        <LegHeader leg={leg} />
        <Heading level="h2">{PHOTO_TITLE[photoMode]}</Heading>
        <View style={styles.steps}>
          {PHOTO_STEPS[photoMode].map((step, i) => (
            <View key={step} style={styles.step}>
              <Body variant="bodyStrong" color={colors.action} style={styles.stepNum}>
                {i + 1}
              </Body>
              <Body style={styles.stepText}>{step}</Body>
            </View>
          ))}
        </View>
        <Body color={colors.textSecondary}>
          Shorts on or trousers rolled up, good light, and a patterned sock or a few pen dots on the
          shin. {PHOTO_TARGET[photoMode]}
        </Body>
      </Screen>
    );
  }

  return (
    <Screen footer={<Button onPress={() => onStart()}>Start</Button>}>
      <LegHeader leg={leg} />
      <Heading level="h2">Walk one slow circle around your leg.</Heading>
      <View style={{ height: spacing.md }} />
      <Body color={colors.textSecondary}>Keep the leg still and fully in frame.</Body>
    </Screen>
  );
}

/** Short instruction per native capture state, shown while the guided UI runs. */
const CAPTURE_STATE_COPY: Record<CaptureState, string> = {
  initializing: 'Starting the camera.',
  ready: 'Point the camera at your leg.',
  detecting: 'Finding your leg. Keep it centered.',
  capturing: 'Walk slowly around your leg.',
  finishing: 'Hold steady.',
  completed: 'Done.',
  cancelled: 'Cancelled.',
  failed: 'Something went wrong.',
};

function CapturingSection({ state }: { state: CaptureFlowState }) {
  return (
    <Screen>
      <LegHeader leg={state.leg} />
      <View accessibilityLiveRegion="polite">
        <Heading level="h2">{CAPTURE_STATE_COPY[state.captureState ?? 'initializing']}</Heading>
      </View>
    </Screen>
  );
}

function ReconstructingSection({ state }: { state: CaptureFlowState }) {
  const percent = Math.round(state.progress * 100);
  return (
    <Screen>
      <LegHeader leg={state.leg} title="Building your model" />
      <Heading level="display" color={colors.brick[500]}>
        {percent}%
      </Heading>
      <View style={{ height: spacing.md }} />
      <ProgressBar fraction={state.progress} />
      <View style={{ height: spacing.md }} />
      <Body color={colors.textSecondary}>Keep the app open.</Body>
    </Screen>
  );
}

/** Covers both the transient 'done' phase and 'uploading' so there is no flicker between them. */
function UploadingSection({ state }: { state: CaptureFlowState }) {
  return (
    <Screen>
      <LegHeader leg={state.leg} title="Saving" />
      <ActivityIndicator size="large" color={colors.textPrimary} style={styles.spinner} />
      <View style={{ height: spacing.lg }} />
      <Body color={colors.textSecondary}>Uploading your scan. Keep the app open.</Body>
    </Screen>
  );
}

/**
 * A leg finished. Before the last leg: an interstitial with Continue. After it:
 * a brief state before the router opens the pair, or with no backend a plain
 * finished message.
 */
function UploadedSection({
  state,
  pairComplete,
  onNextLeg,
}: {
  state: CaptureFlowState;
  pairComplete: boolean;
  onNextLeg: () => void;
}) {
  if (!pairComplete) {
    return (
      <Screen footer={<Button onPress={onNextLeg}>Continue</Button>}>
        <LegHeader leg={state.leg} title={`${LEG_TITLE[state.leg]} done`} />
        <Heading level="h2">Now the other leg.</Heading>
        <OfflineLegNote state={state} />
      </Screen>
    );
  }
  if (!hasSupabaseConfig()) {
    return (
      <Screen>
        <Heading level="display">Both legs done</Heading>
        <OfflineLegNote state={state} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Heading level="display">Both legs saved</Heading>
      <View style={{ height: spacing.lg }} />
      <ActivityIndicator color={colors.textPrimary} accessibilityLabel="Opening your scan" />
    </Screen>
  );
}

/**
 * No backend configured (local dev builds only): nothing was uploaded, so
 * offer to share each leg's OBJ off the phone. Never shown with a backend.
 */
function OfflineLegNote({ state }: { state: CaptureFlowState }) {
  const objPath = state.result?.objPath;
  if (hasSupabaseConfig()) {
    return null;
  }
  if (state.photoCapture || !objPath) {
    return (
      <Body color={colors.textSecondary} style={styles.offline}>
        Not uploaded: this build has no server.
      </Body>
    );
  }
  return (
    <>
      <Body color={colors.textSecondary} style={styles.offline}>
        Not uploaded: this build has no server.
      </Body>
      <View style={{ height: spacing.md }} />
      <Button
        variant="outline"
        onPress={() =>
          Share.share({ url: objPath.startsWith('file://') ? objPath : `file://${objPath}` })
        }
      >
        Share scan file
      </Button>
    </>
  );
}

function UploadFailedSection({
  state,
  onRetry,
  onRescan,
}: {
  state: CaptureFlowState;
  onRetry: () => void;
  onRescan: () => void;
}) {
  return (
    <Screen
      footer={
        <>
          {/* Retry uploads the same capture (no rescan): idempotent, reuses the scan id. */}
          <Button onPress={onRetry}>Retry upload</Button>
          <Button variant="text" onPress={onRescan}>
            Scan again
          </Button>
        </>
      }
    >
      <Heading level="display" color={colors.danger}>
        Upload failed
      </Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        {state.uploadError
          ? uploadErrorMessage(state.uploadError)
          : 'Something went wrong saving the scan.'}
      </Body>
      {state.uploadError && <ErrorCode code={state.uploadError.code} />}
    </Screen>
  );
}

function FailedSection({ state, onRetry }: { state: CaptureFlowState; onRetry: () => void }) {
  return (
    <Screen footer={<Button onPress={onRetry}>Try again</Button>}>
      <Heading level="display" color={colors.danger}>
        Scan failed
      </Heading>
      <View style={{ height: spacing.md }} />
      <Body>{state.error ? captureErrorMessage(state.error) : 'Something went wrong.'}</Body>
      {state.error && <ErrorCode code={state.error.code} />}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Kept as a tiny caption so support can match a report to a cause. */
function ErrorCode({ code }: { code: string }) {
  return (
    <Body variant="caption" color={colors.textTertiary} style={styles.code}>
      Code: {code}
    </Body>
  );
}

/** Determinate progress: a flat brick fill on a brown-tinted track, no glow. */
function ProgressBar({ fraction }: { fraction: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <View
      style={styles.progressTrack}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      <View style={[styles.progressFill, { width: `${percent}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  spinner: { alignSelf: 'flex-start' },
  offline: { marginTop: spacing.md },
  code: { marginTop: spacing.md },
  steps: { marginTop: spacing.md, marginBottom: spacing.lg, gap: spacing.md },
  step: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  stepNum: { width: spacing.lg },
  stepText: { flex: 1 },
  progressTrack: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: radius,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.action,
  },
});
