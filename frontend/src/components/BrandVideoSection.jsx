import { useEffect, useRef, useState } from 'react';
import MoleItLogo from './MoleItLogo';

// Your video: https://youtu.be/EQaBSo9-gY8 — starts (and loops back to)
// 0:04. To swap the clip later, just change these two values.
const YOUTUBE_VIDEO_ID = 'EQaBSo9-gY8';
const START_SECONDS = 28;

// Loads the YouTube IFrame Player API script once and resolves with the
// global `window.YT` object once it's ready. Using the real API instead
// of a plain iframe src is what lets us seek back to START_SECONDS on
// every loop — a plain "start=4&loop=1" URL only honors start= on the
// very first play; every loop after that restarts at 0:00.
let apiLoadPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiLoadPromise) return apiLoadPromise;
  apiLoadPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiLoadPromise;
}

// Famous chemists + short, well-known quotes. Avatars are initials on a
// gradient chip (same pattern as the "SD SM RK AN" testimonial avatars
// elsewhere on the homepage) rather than photos, so there's no external
// image dependency that can break or a licensing question over portraits.
const CHEMIST_QUOTES = [
  {
    initials: 'MC',
    name: 'Marie Curie',
    quote: 'Nothing in life is to be feared, it is only to be understood.',
    chip: 'bg-[#3bbff7] text-[#262626]',
  },
  {
    initials: 'AL',
    name: 'Antoine Lavoisier',
    quote: 'Nothing is lost, nothing is created, everything is transformed.',
    chip: 'bg-[#eea02b] text-[#262626]',
  },
  {
    initials: 'LP',
    name: 'Linus Pauling',
    quote: 'The best way to have a good idea is to have lots of ideas.',
    chip: 'bg-[#262626] text-[#fafaf9]',
  },
  {
    initials: 'DM',
    name: 'Dmitri Mendeleev',
    quote: 'There is no branch of natural science more attractive than chemistry.',
    chip: 'bg-[#3bbff7] text-[#262626]',
  },
  {
    initials: 'RF',
    name: 'Rosalind Franklin',
    quote: 'Science and everyday life cannot and should not be separated.',
    chip: 'bg-[#eea02b] text-[#262626]',
  },
  {
    initials: 'JD',
    name: 'John Dalton',
    quote: 'Matter, though divisible in an extreme degree, is nevertheless not infinitely divisible.',
    chip: 'bg-[#262626] text-[#fafaf9]',
  },
];

function QuoteCard({ initials, name, quote, chip }) {
  return (
    <div className="flex w-[300px] shrink-0 items-start gap-3 rounded-[20px] bg-[#fafaf9] p-4 sm:w-[380px] sm:p-5">
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold ${chip}`}
      >
        {initials}
      </span>
      <div className="min-w-20">
        <p className="text-sm font-medium leading-snug text-[#262626]">&ldquo;{quote}&rdquo;</p>
        <p className="mt-1.5 text-xs font-semibold text-[#8a8681]">{name}</p>
      </div>
    </div>
  );
}

// A slow, seamless horizontal marquee of quote cards. Doubling the list
// and animating a translateX(-50%) loop is what makes the scroll seamless
// — the second copy picks up exactly where the first ends.
function ChemistQuoteMarquee() {
  return (
    <div className="relative mt-4 overflow-hidden sm:mt-5">
      <div className="quote-marquee flex w-max gap-4">
        {[...CHEMIST_QUOTES, ...CHEMIST_QUOTES].map((c, i) => (
          <QuoteCard key={`${c.initials}-${i}`} {...c} />
        ))}
      </div>

      <style>{`
        .quote-marquee { animation: quote-marquee-scroll 42s linear infinite; }
        @keyframes quote-marquee-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(calc(-50% - 8px)); }
        }
        @media (prefers-reduced-motion: reduce) {
          .quote-marquee { animation: none; }
        }
      `}</style>
    </div>
  );
}

// A full-bleed brand-reel moment: a looping ambient video behind the
// MoleIt logo, with a scrolling strip of chemist quotes filling the
// space below the panel.
export default function BrandVideoSection() {
  const mountRef = useRef(null);
  const playerRef = useRef(null);

  // Tracks how many times the logo panel has scrolled into view. Bumping
  // this changes the logo wrapper's `key`, which makes React unmount +
  // remount it — and remounting is what restarts the CSS animation below
  // from scratch, every single time, instead of it only ever playing once
  // on the component's very first mount (e.g. a hard page refresh).
  const [logoPlayKey, setLogoPlayKey] = useState(0);
  const logoObserverTargetRef = useRef(null);
  // Tracks whether the panel is currently on-screen, so the player can be
  // paused instead of decoding + compositing an embedded YouTube iframe
  // for the entire time the user is scrolled somewhere else on the page.
  const isVisibleRef = useRef(false);
  const playerReadyRef = useRef(false);

  useEffect(() => {
    const node = logoObserverTargetRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) {
          setLogoPlayKey((k) => k + 1);
          if (playerReadyRef.current) playerRef.current?.playVideo?.();
        } else if (playerReadyRef.current) {
          playerRef.current?.pauseVideo?.();
        }
      },
      // Fires once the panel is meaningfully on-screen, in both scroll
      // directions (scrolling down into it, or back up into it).
      { threshold: 0.5 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Loading the YouTube API + creating the player is deferred until the
  // panel is getting close to the viewport (a generous 500px rootMargin,
  // so the video is ready the moment it scrolls into view, not popping in
  // a beat late) instead of unconditionally on every homepage load. On a
  // slower mobile connection/CPU that's real work — API script fetch,
  // iframe creation, player boot — spent on a section the person may
  // never even scroll to.
  useEffect(() => {
    const node = logoObserverTargetRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      // No IO support: fall back to the old unconditional behaviour below.
    }

    let cancelled = false;
    let lazyObserver;

    const bootPlayer = () => {
      loadYouTubeApi().then((YT) => {
        if (cancelled || !mountRef.current) return;

        playerRef.current = new YT.Player(mountRef.current, {
          videoId: YOUTUBE_VIDEO_ID,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            mute: 1,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            showinfo: 0,
            iv_load_policy: 3,
            playsinline: 1,
            disablekb: 1,
            start: START_SECONDS,
          },
          events: {
            onReady: (e) => {
              // Make the video cover the entire panel.
              // The source video is 16:9 while the panel is now much wider
              // (shorter/leaner), so we make the iframe wider and crop the
              // top/bottom to fill without stretching.
              const iframe = e.target.getIframe();

              Object.assign(iframe.style, {
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: '100%',
                height: '220%',
                border: '0',
                pointerEvents: 'none',
                transform: 'translate(-50%, -50%)',
              });

              playerReadyRef.current = true;
              e.target.mute();
              // Only actually start playing if the panel is still (or
              // already) on-screen by the time the player finishes
              // booting — it may well not be, given the load took a beat.
              if (isVisibleRef.current) e.target.playVideo();
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED) {
                e.target.seekTo(START_SECONDS, true);
                if (isVisibleRef.current) e.target.playVideo();
              }
            },
          },
        });
      });
    };

    if (typeof IntersectionObserver === 'undefined') {
      bootPlayer();
    } else {
      lazyObserver = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            bootPlayer();
            lazyObserver.disconnect();
          }
        },
        { rootMargin: '500px 0px' }
      );
      lazyObserver.observe(node);
    }

    return () => {
      cancelled = true;
      lazyObserver?.disconnect();
      playerRef.current?.destroy?.();
    };
  }, []);

  return (
    <div>
      <div className="relative overflow-hidden bg-slate-950">
        {/* Shorter, leaner panel — wider aspect ratio means less height on
            every breakpoint, so this reads as a slim brand strip rather
            than a screen-filling video block. */}
        <div className="relative aspect-[3/1] w-full sm:aspect-[32/9] overflow-hidden">
          <div ref={mountRef} className="absolute inset-0" />

          {/* Click-blocker + dark wash so the logo stays legible no
              matter what footage is playing underneath, and so the video
              itself isn't interactive (no accidental clicks into YouTube). */}
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-lab-950/70 via-lab-950/25 to-lab-950/80" />
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(10,14,15,0.65)_100%)]" />

          {/* Centered logo */}
          <div
            ref={logoObserverTargetRef}
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div key={logoPlayKey} className="brand-reel-logo">
              <MoleItLogo size="lg" />
            </div>
          </div>
        </div>
      </div>

      {/* Fills the remaining space below the panel — a slow, looping
          strip of short quotes from famous chemists. */}
      <ChemistQuoteMarquee />

      <style>{`
        .brand-reel-logo { animation: brand-reel-logo-in 1s ease-out both; }

        @keyframes brand-reel-logo-in {
          from { opacity: 0; transform: scale(8.85); }
          to { opacity: 1; transform: scale(1); }
        }

        @media (prefers-reduced-motion: reduce) {
          .brand-reel-logo { animation: none !important; }
        }
      `}</style>
    </div>
  );
}