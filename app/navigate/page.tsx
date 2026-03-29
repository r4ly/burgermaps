"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type NavPayload = {
  destination: string;
  steps: string[];
  eta: string;
  distance: string;
};

const FALLBACK: NavPayload = {
  destination: "Burger King",
  steps: ["Start a route from the main screen first."],
  eta: "--",
  distance: "--",
};

export default function NavigationPage() {
  const [payload] = useState<NavPayload>(() => {
    if (typeof window === "undefined") {
      return FALLBACK;
    }

    const raw = window.sessionStorage.getItem("burgermaps-navigation");
    if (!raw) {
      return FALLBACK;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<NavPayload>;
      if (!parsed.destination || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        return FALLBACK;
      }

      return {
        destination: parsed.destination,
        steps: parsed.steps,
        eta: parsed.eta ?? "--",
        distance: parsed.distance ?? "--",
      };
    } catch {
      return FALLBACK;
    }
  });
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    if (payload.steps.length <= 1) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveStep((prev) => (prev + 1) % payload.steps.length);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [payload.steps]);

  const currentInstruction = useMemo(() => payload.steps[activeStep] ?? payload.steps[0], [
    activeStep,
    payload.steps,
  ]);

  return (
    <div className="nav-shell min-h-screen bg-[linear-gradient(180deg,#e7f2ff_0%,#f6fbff_48%,#ffffff_100%)] px-4 py-5 text-slate-900 sm:px-7 sm:py-8">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <header className="rounded-2xl border border-black/10 bg-white/80 p-4 backdrop-blur-md sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600">Guided navigation</p>
          <h1 className="mt-1 text-xl font-semibold sm:text-2xl">To {payload.destination}</h1>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl border border-black/10 bg-white px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-slate-500">ETA</p>
              <p className="text-base font-semibold text-slate-900">{payload.eta}</p>
            </div>
            <div className="rounded-xl border border-black/10 bg-white px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-slate-500">Distance</p>
              <p className="text-base font-semibold text-slate-900">{payload.distance}</p>
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-black/10 bg-white/85 p-4 shadow-[0_25px_80px_-40px_rgba(2,132,199,0.6)] backdrop-blur-md sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Current instruction</p>
          <p className="mt-2 text-2xl font-semibold leading-tight text-slate-900 sm:text-3xl">{currentInstruction}</p>
          <p className="mt-2 text-sm text-slate-600">Follow signs and keep right when unsure.</p>
        </section>

        <section className="rounded-2xl border border-black/10 bg-white/80 p-4 backdrop-blur-md sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Directions</p>
          <div className="mt-3 space-y-2">
            {payload.steps.map((step, index) => (
              <div
                key={`${step}-${index}`}
                className={`rounded-xl border px-3 py-2 text-sm ${
                  index === activeStep
                    ? "border-sky-400 bg-sky-50 text-slate-900"
                    : "border-black/10 bg-white text-slate-700"
                }`}
              >
                <span className="mr-2 text-xs font-semibold text-slate-500">{index + 1}</span>
                {step}
              </div>
            ))}
          </div>
        </section>

        <Link
          href="/"
          className="inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 sm:w-auto"
        >
          Exit Navigation
        </Link>
      </main>
    </div>
  );
}
