"use client";

import {
  IconLoader2Fill18,
  IconLockOpenOutlineDuo18,
  IconLockOutlineDuo18,
} from "../icons/index.js";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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

function AuthDoorsMedallion({
  engaged = false,
  children,
}: {
  engaged?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex size-14 items-center justify-center rounded-full border border-border-strong bg-popover transition-[box-shadow,transform] duration-500",
        engaged
          ? "scale-[1.08] shadow-[0_8px_24px_oklch(0_0_0/0.12),0_0_40px_color-mix(in_oklab,var(--color-primary-deep)_45%,transparent)] dark:shadow-[0_8px_24px_oklch(0_0_0/0.45),0_0_40px_color-mix(in_oklab,var(--color-primary-deep)_55%,transparent)]"
          : "shadow-[0_8px_24px_oklch(0_0_0/0.12)] dark:shadow-[0_8px_24px_oklch(0_0_0/0.45),0_0_22px_color-mix(in_oklab,var(--color-primary-deep)_25%,transparent)]",
      )}
    >
      {children}
    </div>
  );
}

function RevealStateIcon({ phase }: { phase: RevealAnimationPhase }) {
  const engaged = phase !== "locked";
  return (
    <AuthDoorsMedallion engaged={engaged}>
      <IconLockOutlineDuo18
        className="absolute size-6 text-primary transition-[opacity,transform] duration-300 dark:drop-shadow-[0_0_6px_color-mix(in_oklab,var(--color-primary)_55%,transparent)]"
        style={{
          opacity: engaged ? 0 : 1,
          transform: engaged ? "scale(0.8)" : "scale(1)",
        }}
      />
      <IconLockOpenOutlineDuo18
        className="absolute size-6 text-primary transition-[opacity,transform] duration-300 dark:drop-shadow-[0_0_6px_color-mix(in_oklab,var(--color-primary)_55%,transparent)]"
        style={{
          opacity: engaged ? 1 : 0,
          transform: engaged ? "scale(1)" : "scale(0.8)",
        }}
      />
    </AuthDoorsMedallion>
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
        className="absolute inset-y-0 left-0 z-10 w-1/3 overflow-visible bg-auth-panel"
        style={{
          transform: open ? "translateX(-110%)" : "translateX(0)",
          transition: open
            ? "transform 0.7s cubic-bezier(0.6, 0, 0.2, 1)"
            : "none",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[46%] bg-[radial-gradient(130%_100%_at_35%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_68%)] dark:bg-[radial-gradient(130%_100%_at_35%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_68%)]"
        />

        <div
          className={cn(
            "absolute inset-y-0 right-0 w-px bg-border transition-opacity duration-400",
            open && "opacity-0",
          )}
        >
          <span
            aria-hidden
            className="absolute top-[14%] left-0 h-[28%] w-px animate-[auth-seam-breathe_4.5s_ease-in-out_infinite] bg-linear-to-b from-transparent via-primary/60 to-transparent drop-shadow-[0_0_6px_color-mix(in_oklab,var(--color-primary)_80%,transparent)] dark:via-primary/75"
          />
        </div>

        <div className="absolute top-1/4 right-0 translate-x-1/2">
          {children}
        </div>

        <div className={cn("absolute", logoPositionClassName)}>
          <img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
        </div>
      </div>

      <div
        className="absolute inset-y-0 right-0 w-2/3 bg-background md:w-3/4"
        style={{
          transform: open ? "translateX(100%)" : "translateX(0)",
          transition: open
            ? "transform 0.7s cubic-bezier(0.6, 0, 0.2, 1)"
            : "none",
        }}
      >
        <div className="absolute inset-y-0 left-0 w-px bg-border" />
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
      <AuthDoorsMedallion>
        <IconLoader2Fill18 className="size-6 animate-spin text-primary dark:drop-shadow-[0_0_6px_color-mix(in_oklab,var(--color-primary)_55%,transparent)]" />
      </AuthDoorsMedallion>
    </AuthDoorsOverlay>
  );
}

export function AuthDoorsControlledRevealLoader({
  isVisible,
  onComplete,
  logoPositionClassName,
}: AuthDoorsControlledRevealLoaderProps) {
  const [phase, setPhase] = useState<ControlledRevealPhase>("hidden");
  const handleComplete = useCallback(() => {
    onComplete?.();
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
        handleComplete();
      },
    );
  }, [handleComplete, isVisible]);

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
