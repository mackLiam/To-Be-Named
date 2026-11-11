import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { BufferAttribute, BufferGeometry, type Group } from 'three';

import type { TriangleMesh } from '../lib/legGeometry';
import { colors } from '../theme/tokens';

// Loaded only through React.lazy in LegViewer.tsx. On native, Metro resolves
// @react-three/fiber to its expo-gl build; on web, to the DOM build.

const RADIANS_PER_PX = 0.01;
// Keeps the leg from flipping over the top or bottom while orbiting.
const PITCH_LIMIT = 0.6;

interface Orbit {
  yaw: number;
  pitch: number;
  startYaw: number;
  startPitch: number;
  invalidate: () => void;
}

interface SceneProps {
  leg: TriangleMesh;
  band: TriangleMesh;
  legLengthMm: number;
}

function useBufferGeometry(mesh: TriangleMesh): BufferGeometry {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    g.setIndex(new BufferAttribute(mesh.indices, 1));
    return g;
  }, [mesh]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

function LegModelMesh({ leg, band, legLengthMm, orbit }: SceneProps & { orbit: RefObject<Orbit> }) {
  const group = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const legGeometry = useBufferGeometry(leg);
  const bandGeometry = useBufferGeometry(band);

  useEffect(() => {
    orbit.current.invalidate = () => invalidate();
  }, [invalidate, orbit]);

  useFrame(() => {
    group.current?.rotation.set(orbit.current.pitch, orbit.current.yaw, 0);
  });

  // The only mm to scene-unit conversion: the leg becomes 1 unit tall,
  // centred on the origin. Frame z-up/y-anterior maps to three's y-up with
  // the shin facing the camera (+z), a proper rotation (no mirroring).
  return (
    <group ref={group}>
      <group rotation={[0, Math.PI, 0]}>
        <group rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} scale={1 / legLengthMm}>
          <mesh geometry={legGeometry}>
            <meshLambertMaterial color={colors.yellow} />
          </mesh>
          <mesh geometry={bandGeometry}>
            <meshLambertMaterial
              color={colors.brown[300]}
              polygonOffset
              polygonOffsetFactor={-1}
              polygonOffsetUnits={-1}
            />
          </mesh>
        </group>
      </group>
    </group>
  );
}

export default function LegViewerScene(props: SceneProps) {
  const orbit = useRef<Orbit>({
    yaw: 0,
    pitch: 0,
    startYaw: 0,
    startPitch: 0,
    invalidate: () => {},
  });

  // Capture handlers so this view, not the canvas's own responder, owns drags.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          orbit.current.startYaw = orbit.current.yaw;
          orbit.current.startPitch = orbit.current.pitch;
        },
        onPanResponderMove: (_, g) => {
          const o = orbit.current;
          o.yaw = o.startYaw + g.dx * RADIANS_PER_PX;
          o.pitch = Math.max(
            -PITCH_LIMIT,
            Math.min(PITCH_LIMIT, o.startPitch + g.dy * RADIANS_PER_PX),
          );
          o.invalidate();
        },
      }),
    [],
  );

  return (
    <View style={styles.fill} {...responder.panHandlers}>
      <Canvas flat frameloop="demand" camera={{ position: [0, 0, 2.4], fov: 32 }}>
        <color attach="background" args={[colors.surfaceDark]} />
        <ambientLight intensity={1.1} />
        <directionalLight position={[1, 1.5, 2]} intensity={1.6} />
        <LegModelMesh {...props} orbit={orbit} />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
