import { describe, expect, it } from "vitest";

import { watchLedgerToggleMount } from "@/components/ledger/ledger-explorer";

type FakeTarget = HTMLButtonElement & { focused: boolean };

function target(): FakeTarget {
  return {
    tagName: "BUTTON",
    focused: false,
    focus() {
      this.focused = true;
    },
  } as FakeTarget;
}

function harness() {
  let mounted: FakeTarget | null = null;
  let mutation: (() => void) | null = null;
  let watcherCallback: (() => void) | null = null;
  let disconnected = 0;
  let cancelled: number[] = [];
  const container = {
    querySelector: () => mounted,
  } as unknown as HTMLElement;
  const watcher = {
    observe: (_container: HTMLElement, onMutation: () => void) => {
      mutation = onMutation;
      return () => {
        disconnected += 1;
        mutation = null;
      };
    },
    schedule: (callback: () => void) => {
      watcherCallback = callback;
      return 7;
    },
    cancel: (handle: number) => cancelled.push(handle),
  };
  return {
    container,
    watcher,
    mount: () => {
      mounted = target();
      mutation?.();
      return mounted;
    },
    timeout: () => watcherCallback?.(),
    get disconnected() {
      return disconnected;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe("ledger amendment focus watcher", () => {
  it("focuses after a delayed virtualized mount and cleans up", () => {
    const state = harness();
    let focused = 0;
    let timedOut = 0;
    watchLedgerToggleMount(
      state.container,
      "target",
      (button) => {
        button.focus({ preventScroll: true });
        focused += 1;
      },
      () => {
        timedOut += 1;
      },
      state.watcher,
    );

    const mounted = state.mount();
    expect(mounted?.focused).toBe(true);
    expect(focused).toBe(1);
    expect(timedOut).toBe(0);
    expect(state.disconnected).toBe(1);
    expect(state.cancelled).toEqual([7]);
  });

  it("reports a bounded timeout, then permits an explicit retry", () => {
    const state = harness();
    let timedOut = 0;
    watchLedgerToggleMount(
      state.container,
      "target",
      () => {},
      () => {
        timedOut += 1;
      },
      state.watcher,
    );

    // The injected scheduler is represented by the harness timeout callback.
    state.timeout();
    expect(timedOut).toBe(1);
    expect(state.disconnected).toBe(1);

    let focused = 0;
    watchLedgerToggleMount(
      state.container,
      "target",
      () => {
        focused += 1;
      },
      () => {},
      state.watcher,
    );
    state.mount();
    expect(focused).toBe(1);
  });

  it("cleans up observation and timeout when navigation is replaced or unmounted", () => {
    const state = harness();
    let focused = 0;
    let timedOut = 0;
    const stop = watchLedgerToggleMount(
      state.container,
      "target",
      () => {
        focused += 1;
      },
      () => {
        timedOut += 1;
      },
      state.watcher,
    );

    stop();
    state.mount();
    state.timeout();
    expect(focused).toBe(0);
    expect(timedOut).toBe(0);
    expect(state.disconnected).toBe(1);
    expect(state.cancelled).toEqual([7]);
  });
});
