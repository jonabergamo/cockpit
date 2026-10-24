import { describe, expect, it } from "vitest";
import { handleApi, serveApi } from "../src/remote/forward.ts";

describe("forwarded requests", () => {
  it("does a change once when the hub asks again with the same id", async () => {
    let calls = 0;
    serveApi(async () => new Response(JSON.stringify({ n: ++calls }), { headers: { "content-type": "application/json" } }));
    const req = { op: "same-op", method: "POST", path: "/tasks", headers: { "content-type": "application/json" }, body: "{}" };
    const a = await handleApi(req);
    const b = await handleApi(req);
    expect(calls).toBe(1);
    expect(JSON.parse(b.body)).toEqual(JSON.parse(a.body));
    await handleApi({ ...req, op: "another-op" });
    expect(calls).toBe(2);
  });

  it("asks again for reads, and keeps binary answers intact", async () => {
    let calls = 0;
    serveApi(async () => (calls++, new Response(new Uint8Array([0, 1, 2, 255]), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-3/10" } })));
    const req = { op: "read", method: "GET", path: "/runs/x/artifacts/v.mp4", headers: { range: "bytes=0-3" } };
    const r = await handleApi(req);
    await handleApi(req);
    expect(calls).toBe(2);
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe("bytes 0-3/10");
    expect([...Buffer.from(r.body, "base64")]).toEqual([0, 1, 2, 255]);
  });
});
