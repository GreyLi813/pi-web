/**
 * useScheduleTicker — Wake the server-side persistent schedule dispatcher.
 *
 * The server resolves each task's stored sessionId. The browser's currently
 * selected session never determines the execution target.
 *
 * @author OpenAI Codex
 * @version 3.0.0
 */

"use client";

import { useEffect, useRef } from "react";

interface UseScheduleTickerOptions {
  /** Interval in milliseconds between dispatcher wake-ups. */
  intervalMs?: number;
}

/** Poll the server dispatcher while Pi-Web is open.
 *
 * Multiple browser tabs are safe because the server serializes dispatch.
 *
 * @author OpenAI Codex
 * @version 3.0.0
 */
export function useScheduleTicker({ intervalMs = 10_000 }: UseScheduleTickerOptions = {}): void {
  const requestingRef = useRef(false);

  useEffect(() => {
    let active = true;

    const wakeDispatcher = async (): Promise<void> => {
      if (!active || requestingRef.current) return;
      requestingRef.current = true;
      try {
        const response = await fetch("/api/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "dispatchDue" }),
        });
        if (!response.ok && response.status !== 202) {
          throw new Error(`schedule dispatcher failed: HTTP ${response.status}`);
        }
      } catch (error) {
        console.warn("[scheduler] dispatcher wake-up failed:", error);
      } finally {
        requestingRef.current = false;
      }
    };

    const initialTimer = setTimeout(() => { void wakeDispatcher(); }, 2_000);
    const interval = setInterval(() => { void wakeDispatcher(); }, intervalMs);
    return () => {
      active = false;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [intervalMs]);
}
