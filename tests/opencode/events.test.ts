import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2Event } from "@opencode/client/promise";

const { subscribeMock } = vi.hoisted(() => {
  return {
    subscribeMock: vi.fn(),
  };
});

vi.mock("../../src/opencode/client-v2.js", () => ({
  opencodeClientV2: {
    event: {
      subscribe: subscribeMock,
    },
  },
}));

import { stopEventListening, subscribeToEvents } from "../../src/opencode/events.js";

function createStream(events: V2Event[]): AsyncGenerator<V2Event, void, unknown> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function createAbortableStream(signal: AbortSignal): AsyncGenerator<V2Event, void, unknown> {
  return (async function* () {
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("opencode/events", () => {
  afterEach(() => {
    stopEventListening();
  });

  it("subscribes to stream and forwards events to callback", async () => {
    const eventA = {
      type: "session.status",
      data: { sessionID: "s1", status: { type: "busy" } },
    } as V2Event;
    const eventB = { type: "session.idle", data: { sessionID: "s1" } } as V2Event;
    subscribeMock.mockReturnValueOnce(createStream([eventA, eventB]));

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback);
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(2);
    });
    await flushImmediate();

    stopEventListening();
    await subscription;

    expect(subscribeMock).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0][0]).toEqual(eventA);
    expect(callback.mock.calls[1][0]).toEqual(eventB);
  });

  it("ignores events from other directories", async () => {
    const matchingEvent = {
      type: "session.idle",
      location: { directory: "D:/repo" },
      data: { sessionID: "s1" },
    } as V2Event;
    const otherEvent = {
      type: "session.idle",
      location: { directory: "D:/other" },
      data: { sessionID: "s2" },
    } as V2Event;
    subscribeMock.mockReturnValueOnce(createStream([otherEvent, matchingEvent]));

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback);
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledOnce();
    });

    stopEventListening();
    await subscription;

    expect(callback).toHaveBeenCalledWith(matchingEvent);
  });

  it("does not create duplicate subscription for same directory while active", async () => {
    subscribeMock.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      return createAbortableStream(signal);
    });

    const firstCallback = vi.fn();
    const firstSubscription = subscribeToEvents("D:/repo", firstCallback);

    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    });

    await subscribeToEvents("D:/repo", vi.fn());
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    stopEventListening();
    await firstSubscription;
  });

  it("aborts previous stream when directory changes", async () => {
    let firstSignal: { aborted: boolean } | null = null;

    subscribeMock
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        firstSignal = signal;
        return createAbortableStream(signal);
      })
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        return createAbortableStream(signal);
      });

    const firstSubscription = subscribeToEvents("D:/repo-a", vi.fn());

    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    });

    const secondSubscription = subscribeToEvents("D:/repo-b", vi.fn());

    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2);
    });

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(firstSignal).toEqual(expect.objectContaining({ aborted: true }));

    stopEventListening();
    await Promise.all([firstSubscription, secondSubscription]);
  });

  it("throws when subscription returns no stream", async () => {
    subscribeMock.mockReturnValueOnce(null);

    await expect(subscribeToEvents("D:/repo", vi.fn())).rejects.toThrow(
      "No stream returned from event subscription",
    );
  });

  it("reconnects when stream ends unexpectedly", async () => {
    subscribeMock
      .mockReturnValueOnce(createStream([]))
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        return createAbortableStream(signal);
      });

    const subscription = subscribeToEvents("D:/repo", vi.fn());

    await vi.waitFor(
      () => {
        expect(subscribeMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );

    stopEventListening();
    await subscription;
  });

  it("reconnects after non-fatal stream error", async () => {
    subscribeMock
      .mockImplementationOnce(() => {
        throw new Error("transient stream failure");
      })
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        return createAbortableStream(signal);
      });

    const subscription = subscribeToEvents("D:/repo", vi.fn());

    await vi.waitFor(
      () => {
        expect(subscribeMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );

    stopEventListening();
    await subscription;
  });

  it("does not deliver queued callback after listener is stopped", async () => {
    const event = {
      type: "session.status",
      data: { sessionID: "s1", status: { type: "busy" } },
    } as V2Event;
    subscribeMock.mockReturnValueOnce(createStream([event]));

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback);

    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    });

    await flushImmediate();
    stopEventListening();
    await flushImmediate();
    await subscription;

    expect(callback).not.toHaveBeenCalled();
  });
});
