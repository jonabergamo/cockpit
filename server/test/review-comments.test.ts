import { describe, expect, it, vi } from "vitest";

const reviewComments = vi.fn(async () => [
  { path: "src/a.ts", line: 4, author: "me", body: "This can be null", mine: true },
  { path: "src/b.ts", line: 9, author: "me", body: "Missing test", mine: true },
]);
vi.mock("../src/providers.ts", async (orig) => ({ ...(await orig<typeof import("../src/providers.ts")>()), reviewComments }));

const { db } = await import("../src/db.ts");
const { listReviews } = await import("../src/reviews.ts");

describe("a finished review's comments", () => {
  it("are read from the review in its link, counted and kept for review lessons", async () => {
    db.exec("delete from reviews; delete from review_comments");
    const add = db.prepare("insert into reviews (repo, pr, url, started_at, status, review_url, verdict) values ('owner/repo', ?, 'u', 1, 'done', ?, 'Changes requested')");
    add.run(7, "https://github.com/owner/repo/pull/7#pullrequestreview-42");
    add.run(8, null);
    await listReviews();
    await vi.waitFor(() =>
      expect(db.prepare("select pr, comments from reviews order by pr").all()).toEqual([
        { pr: 7, comments: 2 },
        { pr: 8, comments: null },
      ]),
    );
    expect(reviewComments).toHaveBeenCalledWith({ repo: "owner/repo", n: 7 }, 42);
    expect(db.prepare("select count(*) as n from review_comments where mine = 1").get()).toEqual({ n: 2 });
  });
});
