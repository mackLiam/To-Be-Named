import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Rule } from '../src/components/Rule';
import { Screen } from '../src/components/Screen';
import { captureErrorMessage, useCaptureFlow } from '../src/hooks/useCaptureFlow';
import type { CaptureFlowState } from '../src/hooks/useCaptureFlow';
import type { CaptureState } from '../modules/zells-capture';
import { colors, radius, spacing } from '../src/theme/tokens';

/**
 * The guided capture flow (ROADMAP.md week 2). Deliberately a lab tool:
 * plain phase readouts, raw file paths, reason codes. The polish pass comes
 * after the pipeline proves itself on real legs.
 *
 * All state logic lives in useCaptureFlow; this screen only renders the
 * current phase. Backing out of the screen unmounts the hook, which cancels
 * any in-flight native work and removes event listeners.
 */
export default function CaptureScreen() {
  const router = useRouter();
  const { state, start } = useCaptureFlow();

  return (
    <Screen>
      {state.phase === 'checking' && <CheckingSection />}
      {state.phase === 'unsupported' && <UnsupportedSection state={state} onBack={router.back} />}
      {state.phase === 'ready' && <ReadySection onStart={start} />}
      {state.phase === 'capturing' && <CapturingSection state={state} />}
      {state.phase === 'reconstructing' && <ReconstructingSection state={state} />}
      {state.phase === 'done' && <DoneSection state={state} onRestart={start} />}
      {state.phase === 'failed' && <FailedSection state={state} onRetry={start} />}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Phase sections
// ---------------------------------------------------------------------------

function CheckingSection() {
  return (
    <>
      <Heading level="h1">Checking this device.</Heading>
      <View style={{ height: spacing.md }} />
      <Body color={colors.textSecondary}>
        Confirming the LiDAR sensor and capture support before the scan starts.
      </Body>
    </>
  );
}

/**
 * Copy per unavailability reason. Mirrors the explanatory path on the Scan
 * tab and capture-info: an unsupported device gets told why and what works
 * instead, never a dead end.
 */
const UNSUPPORTED_COPY: Record<'platform' | 'device', string> = {
  platform:
    'Guided capture runs on iPhone only. Your scan library, orders, and shop work the same on this device once a scan exists.',
  device:
    'This iPhone or build cannot run guided capture. It needs a LiDAR sensor (iPhone 12 Pro or later Pro model), iOS 17 or later, and the Zells dev build, not Expo Go.',
};

function UnsupportedSection({ state, onBack }: { state: CaptureFlowState; onBack: () => void }) {
  const reason = state.unavailableReason === 'platform' ? 'platform' : 'device';
  return (
    <>
      <Heading level="h1">Capture is not available here.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>{UNSUPPORTED_COPY[reason]}</Body>
      <View style={{ height: spacing.sm }} />
      <Body variant="caption" color={colors.textTertiary}>
        Reason code: {reason}
      </Body>
      <View style={{ height: spacing.lg }} />
      <Button variant="outline" onPress={onBack}>
        Back
      </Button>
    </>
  );
}

function ReadySection({ onStart }: { onStart: () => void }) {
  return (
    <>
      <Heading level="h1">Ready to scan.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        The camera opens in Apple&apos;s guided capture. Keep the leg still, keep the whole leg in
        frame, and walk one slow, full circle around it.
      </Body>
      <View style={{ height: spacing.lg }} />
      <Button onPress={onStart}>Begin capture</Button>
      <Rule />
      <Body variant="bodySmall" color={colors.textSecondary}>
        Backing out of the camera brings you back here. Nothing is saved until the scan completes.
      </Body>
    </>
  );
}

/** Short instruction per native capture state, shown while the guided UI runs. */
const CAPTURE_STATE_COPY: Record<CaptureState, string> = {
  initializing: 'Starting the camera.',
  ready: 'Point the camera at the leg.',
  detecting: 'Finding the leg. Keep it centered in the frame.',
  capturing: 'Capturing. Walk slowly around the leg.',
  finishing: 'Finishing the pass. Hold steady.',
  completed: 'Capture complete.',
  cancelled: 'Capture cancelled.',
  failed: 'Capture hit a problem.',
};

function CapturingSection({ state }: { state: CaptureFlowState }) {
  const captureState = state.captureState ?? 'initializing';
  return (
    <>
      <Heading level="h1">Capture in progress.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>{CAPTURE_STATE_COPY[captureState]}</Body>
      <View style={{ height: spacing.sm }} />
      <Body variant="caption" color={colors.textTertiary}>
        Session state: {captureState}
      </Body>
    </>
  );
}

function ReconstructingSection({ state }: { state: CaptureFlowState }) {
  const percent = Math.round(state.progress * 100);
  return (
    <>
      <Heading level="h1">Building the mesh.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        Turning {state.capture?.imageCount ?? 'the captured'} photos into a 3D model, all on this
        phone. Keep the app open.
      </Body>
      <View style={{ height: spacing.lg }} />
      <ProgressBar fraction={state.progress} />
      <View style={{ height: spacing.sm }} />
      <Body variant="label" color={colors.textSecondary}>
        {percent}%{state.progressStage ? `, ${state.progressStage}` : ''}
      </Body>
    </>
  );
}

function DoneSection({ state, onRestart }: { state: CaptureFlowState; onRestart: () => void }) {
  const result = state.result;
  return (
    <>
      <Heading level="h1">Scan complete.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>The mesh is on this phone, ready for the measurement pipeline.</Body>
      <Rule />
      {result && (
        <>
          <InfoRow label="Session" value={result.sessionId} />
          <InfoRow label="Images used" value={String(result.imageCount)} />
          <InfoRow label="Detail level" value={result.detail} />
          <InfoRow label="OBJ file" value={result.objPath} />
          <InfoRow label="USDZ file" value={result.usdzPath} />
        </>
      )}
      {/*
        TODO(month-2): upload hooks in here. Send result.objPath to the scan
        library (private bucket, signed upload URL) and create the scan row;
        until then the flow deliberately ends at this summary (ROADMAP.md:
        week 2 is capture only, upload is month 2).
      */}
      <Rule />
      <Body variant="bodySmall" color={colors.textSecondary}>
        Upload to your scan library is not wired up yet. For now, pull the OBJ off the device and
        run it through the extraction pipeline by hand.
      </Body>
      <View style={{ height: spacing.lg }} />
      <Button variant="outline" onPress={onRestart}>
        Scan again
      </Button>
    </>
  );
}

function FailedSection({ state, onRetry }: { state: CaptureFlowState; onRetry: () => void }) {
  return (
    <>
      <Heading level="h1">The scan did not finish.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>{state.error ? captureErrorMessage(state.error) : 'Something went wrong.'}</Body>
      {state.error && (
        <>
          <View style={{ height: spacing.sm }} />
          <Body variant="caption" color={colors.textTertiary}>
            Error code: {state.error.code}
          </Body>
        </>
      )}
      <View style={{ height: spacing.lg }} />
      <Button onPress={onRetry}>Try again</Button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * Determinate reconstruction progress: a flat orange fill on a navy-tinted
 * track. Color block, not shadow or glow (banned looks #5 and #9); the one
 * shared radius token, not a pill (banned look #3).
 */
function ProgressBar({ fraction }: { fraction: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${percent}%` }]} />
    </View>
  );
}

/** Lab-tool metadata row: uppercase label over a raw value, no card, no chip. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Body variant="label" color={colors.textTertiary}>
        {label}
      </Body>
      <View style={{ height: spacing.xs }} />
      <Body variant="bodySmall">{value}</Body>
    </View>
  );
}

const styles = StyleSheet.create({
  progressTrack: {
    height: 10,
    backgroundColor: colors.navy[100],
    borderRadius: radius,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.action,
  },
});
