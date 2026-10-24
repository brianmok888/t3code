import {
  GUEST_RENDER_ROUTE,
  GuestMessageId,
  GuestShareId,
  GuestStreamEvent,
  MessageId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type GuestTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { GuestPage } from "./GuestPage";

const SHARE_ID = "share-1";
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(GuestStreamEvent));

const base = {
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed",
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-23T10:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-23T10:00:05.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-23T10:00:05.000Z"),
} as const;

const items: ReadonlyArray<GuestTurnItem> = [
  {
    ...base,
    id: TurnItemId.make("user"),
    ordinal: 0,
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make("user"),
    inputIntent: "turn_start",
    text: "Run the checks",
    attachments: [],
  },
  {
    ...base,
    id: TurnItemId.make("command"),
    ordinal: 1,
    type: "command_execution",
    input: "vp run check:changed",
    exitCode: 0,
  },
  {
    ...base,
    id: TurnItemId.make("visual"),
    ordinal: 2,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: null,
    output: { htmlRender: { attachmentId: "thread-a-1", title: "Chart", height: 200 } },
  },
  {
    ...base,
    id: TurnItemId.make("reply"),
    ordinal: 3,
    type: "assistant_message",
    messageId: MessageId.make("reply"),
    text: "All checks pass.",
    streaming: false,
  },
];

const snapshot = encodeEvent({
  type: "snapshot",
  view: {
    shareId: GuestShareId.make(SHARE_ID),
    title: "Fix login",
    guestName: "Sam",
    expiresAt: "2026-10-24T10:00:00.000Z",
    messages: [],
    model: { driver: ProviderDriverKind.make("codex"), name: "GPT-5.4", shortName: "5.4" },
  },
  runs: [
    {
      id: RunId.make("run-1"),
      ordinal: 1,
      status: "completed",
      requestedAt: "2026-10-23T10:00:00.000Z",
      startedAt: "2026-10-23T10:00:00.000Z",
      completedAt: "2026-10-23T10:00:05.000Z",
      workStartedAt: "2026-10-23T10:00:00.000Z",
      turnEnded: false,
    },
  ],
  items,
});

/** Delivers the snapshot as soon as the page subscribes. */
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: snapshot })));
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function visit(path: string): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", path);
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}

describe("GuestPage", () => {
  it("shows the shared thread in the real timeline without opening an environment connection", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using _session = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    using _stream = vi.spyOn(window, "EventSource").mockImplementation(FakeEventSource as never);
    using socket = vi.spyOn(window, "WebSocket");
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(<GuestPage />, { container });

    await expect.element(screen.getByText("All checks pass.")).toBeVisible();
    // A finished turn folds its work, as it does for the owner; the command is inside.
    await userEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    await expect.element(screen.getByText("vp run check:changed")).toBeVisible();
    await expect
      .element(screen.getByTitle("Chart"))
      .toHaveAttribute(
        "src",
        expect.stringContaining(`${GUEST_RENDER_ROUTE}?share=${SHARE_ID}&item=visual`),
      );
    // Guests cannot act on the thread, so no control offers to.
    expect(screen.container.querySelector('[aria-label="Fork from this response"]')).toBeNull();
    expect(socket).not.toHaveBeenCalled();
    // The composer names the thread's model, as the owner's does, with nothing to pick.
    await expect.element(screen.getByLabelText("Model: 5.4")).toBeVisible();
  });

  it("sends attached files with the message, as form data", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using fetchSpy = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    using _stream = vi.spyOn(window, "EventSource").mockImplementation(FakeEventSource as never);
    await using screen = await render(<GuestPage />);

    await expect.element(screen.getByLabelText("Attach files")).toBeVisible();
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("Files to attach"), notes);
    await expect.element(screen.getByText("notes.txt")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/guest/messages?share=${SHARE_ID}`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = fetchSpy.mock.calls.find(
      ([url]) => url === `/api/guest/messages?share=${SHARE_ID}`,
    )?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("shareId")).toBe(SHARE_ID);
    expect(form.get("text")).toBe("");
    expect((form.get("file") as File).name).toBe("notes.txt");
    // Sent files leave the composer.
    await expect.element(screen.getByText("notes.txt")).not.toBeInTheDocument();
  });

  it("follows the end as replies stream, and shows the guest's own message even after they scrolled up", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using _session = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const sources: Array<EventTarget> = [];
    // Enough turns that the thread overflows the page.
    const longItems: ReadonlyArray<GuestTurnItem> = Array.from({ length: 12 }, (_, index) => ({
      ...base,
      id: TurnItemId.make(`reply-${index}`),
      ordinal: index,
      type: "assistant_message" as const,
      messageId: MessageId.make(`reply-${index}`),
      text: `Reply ${index}\n\n${"A long paragraph about the change. ".repeat(20)}`,
      streaming: false,
    }));
    const view = {
      shareId: GuestShareId.make(SHARE_ID),
      title: "Fix login",
      guestName: "Sam",
      expiresAt: "2026-10-24T10:00:00.000Z",
      messages: [],
      model: { driver: null, name: "gpt-5.4" },
    };
    const run = {
      id: RunId.make("run-1"),
      ordinal: 1,
      status: "running" as const,
      requestedAt: "2026-10-23T10:00:00.000Z",
      startedAt: "2026-10-23T10:00:00.000Z",
      completedAt: null,
      workStartedAt: "2026-10-23T10:00:00.000Z",
      turnEnded: false,
    };
    using _stream = vi.spyOn(window, "EventSource").mockImplementation(
      class extends EventTarget {
        static readonly CLOSED = 2;
        readyState = 1;
        constructor() {
          super();
          sources.push(this);
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: encodeEvent({ type: "snapshot", view, runs: [run], items: longItems }),
              }),
            ),
          );
        }
        close() {
          this.readyState = 2;
        }
      } as never,
    );
    const send = (event: GuestStreamEvent) =>
      sources.at(-1)!.dispatchEvent(new MessageEvent("message", { data: encodeEvent(event) }));
    const container = document.createElement("div");
    container.style.cssText = "height: 600px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(<GuestPage />, { container });
    await expect.element(screen.getByText("Reply 11")).toBeInTheDocument();
    const scroller = () =>
      screen.container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
    const expectAtEnd = () =>
      vi.waitFor(() => {
        const node = scroller();
        expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeLessThan(2);
      });
    await expectAtEnd();

    // A new reply streams in at the end.
    send({
      type: "item",
      item: {
        ...base,
        id: TurnItemId.make("reply-new"),
        ordinal: 20,
        type: "assistant_message",
        messageId: MessageId.make("reply-new"),
        text: `Newest reply\n\n${"More words as the agent writes. ".repeat(30)}`,
        streaming: true,
      },
    });
    await expect.element(screen.getByText("Newest reply")).toBeInTheDocument();
    await expectAtEnd();

    // The guest reads back a little, then sends: their message comes into view anyway, as the
    // owner's own send does.
    const node = scroller();
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    node.scrollTop = node.scrollTop - 400;
    node.dispatchEvent(new Event("scroll"));
    await expect.element(screen.getByRole("button", { name: /scroll to/i })).toBeVisible();

    // The guest's own message waits at the end for the owner.
    send({
      type: "view",
      view: {
        ...view,
        messages: [
          {
            id: GuestMessageId.make("guest-1"),
            text: "Can you also check the logout flow?",
            status: "pending",
            submittedAt: "2026-10-23T10:01:00.000Z",
          },
        ],
      },
    });
    await expect
      .element(screen.getByText("Can you also check the logout flow?"))
      .toBeInTheDocument();
    await expectAtEnd();

    // The owner sends it: the run ends, the message becomes a row, and a new run's reply grows.
    const sent = {
      id: GuestMessageId.make("guest-1"),
      text: "Can you also check the logout flow?",
      status: "sent" as const,
      submittedAt: "2026-10-23T10:01:00.000Z",
    };
    send({
      type: "run",
      run: {
        ...run,
        status: "completed",
        completedAt: "2026-10-23T10:01:00.000Z",
        turnEnded: true,
      },
    });
    send({ type: "view", view: { ...view, messages: [sent] } });
    const run2 = {
      ...run,
      id: RunId.make("run-2"),
      ordinal: 2,
      requestedAt: "2026-10-23T10:01:01.000Z",
    };
    send({ type: "run", run: run2 });
    send({
      type: "item",
      item: {
        ...base,
        runId: RunId.make("run-2"),
        id: TurnItemId.make("guest-row"),
        ordinal: 30,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("guest-row"),
        inputIntent: "turn_start",
        text: "Message from guest Sam, sent by the owner: Can you also check the logout flow?",
        attachments: [],
        context: {
          version: 1,
          guest: { guestMessageId: sent.id, name: "Sam", text: sent.text },
          records: [],
        },
      },
    });
    await expectAtEnd();
    for (const words of [10, 40, 120]) {
      send({
        type: "item",
        item: {
          ...base,
          runId: RunId.make("run-2"),
          id: TurnItemId.make("logout-reply"),
          ordinal: 31,
          type: "assistant_message",
          messageId: MessageId.make("logout-reply"),
          text: `Logout reply\n\n${"Checking the logout flow now. ".repeat(words)}`,
          streaming: true,
        },
      });
      await expectAtEnd();
      await expect.element(screen.getByText("Logout reply")).toBeInTheDocument();
    }
  });
});
