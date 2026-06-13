import type Lenis from 'lenis';

declare global {
  interface Window {
    // Lenis smooth-scroll instance, exposed by Layout.astro for GSAP
    // ScrollTrigger sync and for islands that must pause it (modals).
    __lenis?: Lenis | null;
  }
}

export {};
