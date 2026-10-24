import { describe, expect, it } from "vitest";
import { onFrame } from "../src/remote/terminals.ts";

const term = () => ({ epoch: undefined as number | undefined, start: 0, end: 0, buf: "", info: { id: "t" } as never, sockets: new Set<never>() });
const frame = (epoch: number, offset: number, data: string) => ({ id: "t", epoch, offset, data });

describe("following a node's terminal", () => {
  it("starts from the first frame and appends in order", () => {
    const t = term();
    onFrame(t, frame(1, 100, "abc"));
    onFrame(t, frame(1, 103, "def"));
    expect(t).toMatchObject({ epoch: 1, start: 100, end: 106, buf: "abcdef" });
  });

  it("keeps only the new part of a frame that overlaps, as on resume", () => {
    const t = term();
    onFrame(t, frame(1, 0, "hello"));
    onFrame(t, frame(1, 3, "lo world"));
    expect(t.buf).toBe("hello world");
    onFrame(t, frame(1, 2, "llo"));
    expect(t.buf).toBe("hello world");
  });

  it("starts over on a new tmux client or a gap it can't fill", () => {
    const t = term();
    onFrame(t, frame(1, 0, "old screen"));
    onFrame(t, frame(2, 0, "new screen"));
    expect(t).toMatchObject({ epoch: 2, buf: "new screen" });
    onFrame(t, frame(2, 500, "after a gap"));
    expect(t).toMatchObject({ start: 500, end: 511, buf: "after a gap" });
  });
});
