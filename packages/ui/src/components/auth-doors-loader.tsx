"use client";

import {
  IconLoader2Fill18,
  IconLockOpenOutlineDuo18,
  IconLockOutlineDuo18,
} from "../icons/index.js";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

const DEFAULT_LOGO_POSITION = "top-8 left-4 sm:top-9 sm:left-6";
const UNLOCK_DELAY_MS = 400;
const OPEN_DELAY_MS = 700;
const COMPLETE_DELAY_MS = 1500;

type RevealAnimationPhase = "locked" | "unlocked" | "opening";
type ControlledRevealPhase = "hidden" | RevealAnimationPhase;
type InitialRevealPhase = "waiting" | RevealAnimationPhase | "done";

interface AuthDoorsOverlayProps {
  open: boolean;
  children?: ReactNode;
  logoPositionClassName?: string;
}

interface AuthDoorsLoaderProps {
  logoPositionClassName?: string;
}

interface AuthDoorsControlledRevealLoaderProps extends AuthDoorsLoaderProps {
  isVisible: boolean;
  onComplete?: () => void;
}

interface AuthDoorsInitialRevealLoaderProps extends AuthDoorsLoaderProps {
  isLoading: boolean;
}

function runRevealSequence(
  setPhase: (phase: RevealAnimationPhase) => void,
  onComplete: () => void,
) {
  setPhase("locked");
  window.setTimeout(() => setPhase("unlocked"), UNLOCK_DELAY_MS);
  window.setTimeout(() => setPhase("opening"), OPEN_DELAY_MS);
  window.setTimeout(onComplete, COMPLETE_DELAY_MS);
}

function RevealStateIcon({ phase }: { phase: RevealAnimationPhase }) {
  return (
    <div className="relative flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
      <IconLockOutlineDuo18
        className="size-7 text-primary transition-opacity duration-300"
        style={{ opacity: phase === "locked" ? 1 : 0 }}
      />
      <IconLockOpenOutlineDuo18
        className="absolute size-7 text-primary transition-opacity duration-300"
        style={{
          opacity: phase === "unlocked" || phase === "opening" ? 1 : 0,
        }}
      />
    </div>
  );
}

export function AuthDoorsOverlay({
  open,
  children,
  logoPositionClassName = DEFAULT_LOGO_POSITION,
}: AuthDoorsOverlayProps) {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-9999"
      aria-hidden="true"
    >
      <div
        className="absolute inset-y-0 left-0 z-10 w-1/3 overflow-visible bg-secondary"
        style={{
          transform: open ? "translateX(-110%)" : "translateX(0)",
          transition: open
            ? "transform 0.7s cubic-bezier(0.76, 0, 0.24, 1)"
            : "none",
        }}
      >
        <div className="absolute inset-y-0 right-0 w-0.5 bg-black/10 dark:bg-white/10" />

        <div className="absolute top-1/4 right-0 translate-x-1/2">
          {children}
        </div>

        <div className={cn("absolute", logoPositionClassName)}>
          <img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
        </div>
      </div>

      <div
        className="absolute inset-y-0 right-0 w-2/3 bg-white md:w-3/4 dark:bg-gray-900"
        style={{
          transform: open ? "translateX(100%)" : "translateX(0)",
          transition: open
            ? "transform 0.7s cubic-bezier(0.76, 0, 0.24, 1)"
            : "none",
        }}
      >
        <div className="absolute inset-y-0 left-0 w-0.5 bg-black/10 dark:bg-white/10" />
      </div>
    </div>
  );
}

export function AuthDoorsPendingLoader({
  logoPositionClassName,
}: AuthDoorsLoaderProps) {
  return (
    <AuthDoorsOverlay
      open={false}
      logoPositionClassName={logoPositionClassName}
    >
      <div className="flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
        <IconLoader2Fill18 className="size-7 animate-spin text-primary" />
      </div>
    </AuthDoorsOverlay>
  );
}

export function AuthDoorsControlledRevealLoader({
  isVisible,
  onComplete,
  logoPositionClassName,
}: AuthDoorsControlledRevealLoaderProps) {
  const [phase, setPhase] = useState<ControlledRevealPhase>("hidden");
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (!isVisible) {
      setPhase("hidden");
      return;
    }

    runRevealSequence(
      (nextPhase) => setPhase(nextPhase),
      () => {
        setPhase("hidden");
        onCompleteRef.current?.();
      },
    );
  }, [isVisible]);

  if (phase === "hidden") {
    return null;
  }

  return (
    <AuthDoorsOverlay
      open={phase === "opening"}
      logoPositionClassName={logoPositionClassName}
    >
      <RevealStateIcon phase={phase} />
    </AuthDoorsOverlay>
  );
}

export function AuthDoorsInitialRevealLoader({
  isLoading,
  logoPositionClassName,
}: AuthDoorsInitialRevealLoaderProps) {
  const [phase, setPhase] = useState<InitialRevealPhase>("waiting");
  const hasPlayed = useRef(false);

  useEffect(() => {
    if (hasPlayed.current) {
      return;
    }

    if (isLoading) {
      setPhase("waiting");
      return;
    }

    hasPlayed.current = true;
    runRevealSequence(
      (nextPhase) => setPhase(nextPhase),
      () => setPhase("done"),
    );
  }, [isLoading]);

  if (phase === "waiting" || phase === "done") {
    return null;
  }

  return (
    <AuthDoorsOverlay
      open={phase === "opening"}
      logoPositionClassName={logoPositionClassName}
    >
      <RevealStateIcon phase={phase} />
    </AuthDoorsOverlay>
  );
}
