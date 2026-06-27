import { useEffect, useRef } from 'react';

export default function HeroShader() {
  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      if (fallbackRef.current) fallbackRef.current.style.opacity = '1';
      return;
    }

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const { Renderer, Program, Mesh, Triangle, Vec2 } = await import('ogl');
        if (cancelled || !container) return;

        const renderer = new Renderer({
          alpha: true,
          antialias: false,
          dpr: Math.min(window.devicePixelRatio, 2),
        });
        const gl = renderer.gl;
        gl.clearColor(0, 0, 0, 0);
        container.appendChild(gl.canvas);

        const geometry = new Triangle(gl);

        const fragment = /* glsl */ `
          precision highp float;

          uniform float uTime;
          uniform vec2 uResolution;
          uniform vec2 uMouse;

          varying vec2 vUv;

          // hash + noise for organic drift
          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }

          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
              mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }

          // distance to closest node in a jittered grid (Worley-ish)
          vec3 nodes(vec2 uv, float t) {
            vec2 gv = uv * 5.0;
            vec2 id = floor(gv);
            vec2 lv = fract(gv) - 0.5;

            float minDist = 10.0;
            float secondDist = 10.0;
            vec2 closest = vec2(0.0);

            for (int y = -1; y <= 1; y++) {
              for (int x = -1; x <= 1; x++) {
                vec2 offs = vec2(float(x), float(y));
                vec2 nid = id + offs;
                float h = hash(nid);
                vec2 jitter = vec2(
                  sin(t * 0.4 + h * 6.283) * 0.35,
                  cos(t * 0.35 + h * 6.283) * 0.35
                );
                vec2 p = offs + jitter - lv;
                float d = length(p);
                if (d < minDist) {
                  secondDist = minDist;
                  minDist = d;
                  closest = nid;
                } else if (d < secondDist) {
                  secondDist = d;
                }
              }
            }

            // edge proximity = thin line between two closest nodes
            float edge = secondDist - minDist;

            return vec3(minDist, edge, hash(closest));
          }

          void main() {
            vec2 uv = (vUv - 0.5);
            uv.x *= uResolution.x / uResolution.y;

            // gentle mouse warp
            vec2 m = (uMouse - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
            float md = length(uv - m);
            uv += (uv - m) * smoothstep(0.6, 0.0, md) * 0.08;

            float t = uTime * 0.35;
            vec3 n = nodes(uv, t);

            // node dots
            float dot1 = smoothstep(0.08, 0.0, n.x);
            float halo = smoothstep(0.25, 0.05, n.x) * 0.25;

            // edges (between neighbouring cells)
            float edges = smoothstep(0.06, 0.0, n.y) * 0.6;

            // pulse traveling along edges
            float pulse = sin(uTime * 1.2 + n.z * 6.283 + n.x * 8.0) * 0.5 + 0.5;
            edges *= 0.5 + pulse * 0.8;

            // subtle background noise
            float bg = noise(uv * 3.0 + t * 0.2) * 0.04;

            float intensity = dot1 + halo + edges + bg;

            // cool desaturated palette matching site
            vec3 colA = vec3(0.78, 0.83, 0.89); // soft cool white
            vec3 colB = vec3(0.34, 0.42, 0.55); // muted slate
            vec3 col = mix(colB, colA, intensity);

            // vignette
            float vig = smoothstep(1.1, 0.3, length(uv));

            gl_FragColor = vec4(col * intensity, intensity * vig * 0.9);
          }
        `;

        const vertex = /* glsl */ `
          attribute vec2 position;
          attribute vec2 uv;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 0.0, 1.0);
          }
        `;

        const program = new Program(gl, {
          vertex,
          fragment,
          uniforms: {
            uTime: { value: 0 },
            uResolution: { value: new Vec2(1, 1) },
            uMouse: { value: new Vec2(0.5, 0.5) },
          },
          transparent: true,
        });

        const mesh = new Mesh(gl, { geometry, program });

        const mouseTarget = new Vec2(0.5, 0.5);
        const mouseEased = new Vec2(0.5, 0.5);

        function resize() {
          const rect = container!.getBoundingClientRect();
          renderer.setSize(rect.width, rect.height);
          program.uniforms.uResolution.value.set(rect.width, rect.height);
        }
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(container);

        function onMouseMove(e: MouseEvent) {
          const rect = container!.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          const y = 1 - (e.clientY - rect.top) / rect.height;
          mouseTarget.set(x, y);
        }
        window.addEventListener('mousemove', onMouseMove, { passive: true });

        let rafId = 0;
        let visible = true;
        const io = new IntersectionObserver(
          (entries) => {
            visible = entries[0]?.isIntersecting ?? true;
          },
          { threshold: 0.05 },
        );
        io.observe(container);

        const start = performance.now();
        function render() {
          if (cancelled) return;
          if (visible) {
            const t = (performance.now() - start) / 1000;
            mouseEased.x += (mouseTarget.x - mouseEased.x) * 0.06;
            mouseEased.y += (mouseTarget.y - mouseEased.y) * 0.06;
            program.uniforms.uMouse.value.set(mouseEased.x, mouseEased.y);
            program.uniforms.uTime.value = t;
            renderer.render({ scene: mesh });
          }
          rafId = requestAnimationFrame(render);
        }
        render();

        cleanup = () => {
          cancelAnimationFrame(rafId);
          ro.disconnect();
          io.disconnect();
          window.removeEventListener('mousemove', onMouseMove);
          gl.canvas.remove();
          // Removing the canvas doesn't free the GL context; release it
          // explicitly so remounts don't exhaust the browser's context pool.
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        };
      } catch (err) {
        console.warn('[HeroShader] WebGL unavailable, using fallback', err);
        if (fallbackRef.current) fallbackRef.current.style.opacity = '1';
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        style={{ opacity: 0.55 }}
      />
      <div
        ref={fallbackRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center"
        style={{ opacity: 0, transition: 'opacity 600ms' }}
      >
        <svg
          viewBox="0 0 800 500"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          style={{ opacity: 0.5 }}
        >
          <defs>
            <radialGradient id="nodeGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#cdd2d8" stopOpacity="1" />
              <stop offset="100%" stopColor="#cdd2d8" stopOpacity="0" />
            </radialGradient>
          </defs>
          {Array.from({ length: 24 }).map((_, i) => {
            const x = (i % 6) * 130 + 80 + ((i * 37) % 40);
            const y = Math.floor(i / 6) * 110 + 70 + ((i * 53) % 30);
            return (
              <circle key={i} cx={x} cy={y} r={3} fill="#cdd2d8" opacity={0.7}>
                <animate
                  attributeName="opacity"
                  values="0.2;0.9;0.2"
                  dur={`${4 + (i % 5)}s`}
                  repeatCount="indefinite"
                />
              </circle>
            );
          })}
          {Array.from({ length: 18 }).map((_, i) => {
            const x1 = (i % 6) * 130 + 80;
            const y1 = Math.floor(i / 6) * 110 + 70;
            const x2 = ((i + 1) % 6) * 130 + 80;
            const y2 = Math.floor((i + 1) / 6) * 110 + 70;
            return (
              <line
                key={`l${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#5e6469"
                strokeWidth="0.5"
                opacity={0.4}
              />
            );
          })}
        </svg>
      </div>
    </>
  );
}
