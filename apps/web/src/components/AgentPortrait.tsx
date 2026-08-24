import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import { Suspense, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useReducedMotion } from '@app/lib/hooks';
import { AgentGlyph } from './AgentGlyph';

/**
 * Pseudo-depth portrait.
 *
 * There is no attempt to reconstruct a real 3D head from one photograph: the
 * shader treats image luminance as a depth field and parallaxes the sample by
 * the pointer. That reads as physical presence at a fraction of the cost, and it
 * degrades honestly when there is no image at all.
 */
const VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = `
  uniform sampler2D uTexture;
  uniform vec2 uPointer;
  uniform float uTime;
  uniform float uHasTexture;
  uniform vec3 uTintLow;
  uniform vec3 uTintHigh;
  varying vec2 vUv;

  float xbamLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec2 centred = vUv - 0.5;

    vec3 base;
    if (uHasTexture > 0.5) {
      // Depth from luminance, then re-sample with a pointer-driven offset.
      float depth = xbamLuma(texture2D(uTexture, vUv).rgb);
      vec2 parallax = uPointer * (depth - 0.5) * 0.055;
      base = texture2D(uTexture, vUv + parallax).rgb;
    } else {
      // Procedural fallback: a slow, quiet field so the frame is never empty.
      float radial = length(centred * vec2(1.15, 1.0));
      float drift = sin(vUv.x * 3.1 + uTime * 0.18) * 0.5 + cos(vUv.y * 2.4 - uTime * 0.13) * 0.5;
      float mixer = clamp(0.62 - radial + drift * 0.09 + uPointer.x * 0.045, 0.0, 1.0);
      base = mix(uTintLow, uTintHigh, mixer);
      base *= smoothstep(0.86, 0.24, radial);
    }

    // Rim light and vignette give the plane a sense of volume.
    float rim = smoothstep(0.52, 0.16, length(centred));
    base *= mix(0.55, 1.06, rim);
    base += vec3(0.05, 0.055, 0.062) * pow(1.0 - rim, 2.4);

    gl_FragColor = vec4(base, 1.0);
  }
`;

/** Loads the image, then hands the plane a ready texture. Suspends while loading. */
function TexturedPlane({ imageUrl, reduced }: { imageUrl: string; reduced: boolean }) {
  const texture = useTexture(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return <PortraitPlane texture={texture} reduced={reduced} />;
}

function PortraitPlane({ texture, reduced }: { texture: THREE.Texture | null; reduced: boolean }) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const pointer = useRef(new THREE.Vector2(0, 0));
  const { viewport } = useThree();

  const uniforms = useMemo(
    () => ({
      uTexture: { value: texture },
      uPointer: { value: new THREE.Vector2(0, 0) },
      uTime: { value: 0 },
      uHasTexture: { value: texture ? 1 : 0 },
      uTintLow: { value: new THREE.Color('#2A2F38') },
      uTintHigh: { value: new THREE.Color('#BBCCD7') },
    }),
    [texture],
  );

  useFrame((state, delta) => {
    if (!material.current) return;
    material.current.uniforms.uTime!.value += delta;
    const target = reduced ? { x: 0, y: 0 } : state.pointer;
    // Ease toward the pointer so motion feels weighted rather than twitchy.
    pointer.current.x += (target.x - pointer.current.x) * Math.min(1, delta * 3.2);
    pointer.current.y += (target.y - pointer.current.y) * Math.min(1, delta * 3.2);
    (material.current.uniforms.uPointer!.value as THREE.Vector2).copy(pointer.current);
  });

  const size = Math.min(viewport.width, viewport.height) * 0.92;

  return (
    <mesh>
      <planeGeometry args={[size, size, 1, 1]} />
      <shaderMaterial ref={material} vertexShader={VERTEX} fragmentShader={FRAGMENT} uniforms={uniforms} />
    </mesh>
  );
}

export function AgentPortrait({
  agentId,
  name,
  imageUrl,
  className,
}: {
  agentId: string;
  name: string;
  imageUrl?: string | null;
  className?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <div className={className} aria-hidden>
      <Canvas
        dpr={[1, 1.75]}
        frameloop={reduced ? 'demand' : 'always'}
        gl={{ antialias: true, powerPreference: 'low-power' }}
        camera={{ position: [0, 0, 2.4], fov: 45 }}
      >
        <Suspense fallback={<PortraitPlane texture={null} reduced={reduced} />}>
          {imageUrl ? (
            <TexturedPlane imageUrl={imageUrl} reduced={reduced} />
          ) : (
            <PortraitPlane texture={null} reduced={reduced} />
          )}
        </Suspense>
      </Canvas>
      {/* Screen readers and no-WebGL browsers get the flat likeness instead. */}
      <span className="sr-only">{name}</span>
      <noscript>
        <AgentGlyph agentId={agentId} name={name} imageUrl={imageUrl} size="xl" interactive={false} />
      </noscript>
    </div>
  );
}
