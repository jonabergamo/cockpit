import { lazy, Suspense, type ComponentProps } from "react";

// The diff review runs on the code editor, megabytes of it, so it's fetched the first time one opens rather than
// with the app
const DiffReviewNow = lazy(() => import("./DiffReview").then((m) => ({ default: m.DiffReview })));

export function DiffReview(props: ComponentProps<typeof DiffReviewNow>) {
  return (
    <Suspense fallback={null}>
      <DiffReviewNow {...props} />
    </Suspense>
  );
}
